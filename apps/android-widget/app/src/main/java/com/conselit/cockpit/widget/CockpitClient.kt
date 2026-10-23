package com.conselit.cockpit.widget

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.FormBody
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.time.Clock
import java.time.LocalDate
import java.util.concurrent.TimeUnit

/** What a read of Cockpit came to. Every way it can go is a case the widget answers differently. */
sealed interface Read<out T> {
    data class Data<T>(val value: T) : Read<T>

    /** The server could not be reached. */
    data object Offline : Read<Nothing>

    /** The server answered, and not with a list: busy, broken or asked too often. */
    data object ServerError : Read<Nothing>

    /** The Panel was deleted, or was never this person's. */
    data object NotFound : Read<Nothing>

    /** The address this app reads has been retired. */
    data object NeedsNewerVersion : Read<Nothing>

    /** The sign-in is over: Disconnect was pressed, or the person lost access. The stored sign-in is gone. */
    data object SignedOut : Read<Nothing>
}

/** How signing in ended. */
sealed interface SignedIn {
    data object Yes : SignedIn
    data object Offline : SignedIn
    data class Failed(val reason: String) : SignedIn
}

@Serializable
private data class Registered(val client_id: String)

@Serializable
private data class Tokens(val access_token: String, val refresh_token: String? = null, val expires_in: Long = 3600)

@Serializable
private data class OAuthError(val error: String? = null)

/**
 * Cockpit as this app sees it: one registration, a token that renews itself, and
 * the two reads. Fixed to the one origin this build was made for.
 *
 * **One renewal at a time.** Refresh tokens rotate, so two renewals racing would
 * spend the same one twice and sign the phone out; a read that finds the token
 * already renewed by another uses that one.
 */
class CockpitClient(
    private val origin: String,
    private val redirectUri: String,
    private val session: SessionStore,
    private val clock: Clock,
    private val http: OkHttpClient = defaultHttp(),
) {
    private val root = origin.trimEnd('/')
    private val renewing = Any()

    /** Registers this install once; the answer is kept. Null where the server could not be reached or refused. */
    fun clientId(): String? {
        session.clientId()?.let { return it }
        // Defaults written out too: the server is told this is a public client, not left to guess.
        val body = Json { encodeDefaults = true }.encodeToString(
            RegistrationBody.serializer(),
            RegistrationBody(redirect_uris = listOf(redirectUri)),
        )
        val request = Request.Builder().url("$root/oauth/register")
            .post(body.toRequestBody(JSON))
            .build()
        return try {
            http.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return null
                val id = Wire.json.decodeFromString<Registered>(response.body!!.string()).client_id
                session.saveClientId(id)
                id
            }
        } catch (e: IOException) {
            null
        } catch (e: kotlinx.serialization.SerializationException) {
            null
        }
    }

    /** Trades the code the browser brought back for the sign-in every widget shares. */
    fun signIn(code: String, verifier: String): SignedIn {
        val clientId = session.clientId() ?: return SignedIn.Failed("not registered")
        val form = FormBody.Builder()
            .add("grant_type", "authorization_code")
            .add("code", code)
            .add("redirect_uri", redirectUri)
            .add("client_id", clientId)
            .add("code_verifier", verifier)
            .build()
        return try {
            http.newCall(Request.Builder().url("$root/oauth/token").post(form).build()).execute().use { response ->
                if (response.isSuccessful) {
                    val signedIn = sessionFrom(response, previousRefresh = null)
                    // A phone whose key store cannot keep it safe keeps nothing, and says so.
                    if (!keep(signedIn)) SignedIn.Failed("could not keep the sign-in safe on this phone") else SignedIn.Yes
                } else {
                    val reason = errorOf(response)
                    // A registration the server no longer holds is made again at the next sign-in.
                    if (reason == "invalid_client") session.forgetClientId()
                    if (response.code >= 500) SignedIn.Offline else SignedIn.Failed(reason)
                }
            }
        } catch (e: IOException) {
            SignedIn.Offline
        } catch (e: kotlinx.serialization.SerializationException) {
            SignedIn.Failed("unreadable answer")
        }
    }

    fun panelList(): Read<PanelList> = authorized("$root/apps/v1/panels") { Wire.json.decodeFromString<PanelList>(it) }

    fun panelRead(panelId: String, today: LocalDate): Read<PanelRead> {
        val url = "$root/apps/v1/panels".toHttpUrl().newBuilder()
            .addPathSegment(panelId)
            .addQueryParameter("date", today.toString())
            .build()
        return authorized(url.toString()) { Wire.json.decodeFromString<PanelRead>(it) }
    }

    private fun <T> authorized(url: String, parse: (String) -> T): Read<T> {
        var token = when (val got = accessToken(rejected = null)) {
            is Token.Have -> got.value
            Token.Offline -> return Read.Offline
            Token.SignedOut -> return Read.SignedOut
        }
        // Asked at most twice: a refused token is renewed once, and refused again is a sign-in that is over.
        repeat(2) { attempt ->
            val outcome = try {
                http.newCall(Request.Builder().url(url).get().header("Authorization", "Bearer $token").build())
                    .execute().use { answer(it, parse) }
            } catch (e: IOException) {
                return Read.Offline
            }
            if (outcome != null) return outcome
            if (attempt == 1) return signOut()
            token = when (val got = accessToken(rejected = token)) {
                is Token.Have -> got.value
                Token.Offline -> return Read.Offline
                Token.SignedOut -> return Read.SignedOut
            }
        }
        return signOut()
    }

    /** The read's answer, or null for a refused token, which the caller renews and asks again with. */
    private fun <T> answer(response: Response, parse: (String) -> T): Read<T>? = when {
        response.code == 401 -> null
        response.isSuccessful -> try {
            Read.Data(parse(response.body!!.string()))
        } catch (e: kotlinx.serialization.SerializationException) {
            Read.ServerError
        }
        response.code == 404 -> Read.NotFound
        response.code == 410 -> Read.NeedsNewerVersion
        else -> Read.ServerError
    }

    private fun signOut(): Read.SignedOut {
        session.clear()
        return Read.SignedOut
    }

    private sealed interface Token {
        data class Have(val value: String) : Token
        data object Offline : Token
        data object SignedOut : Token
    }

    /**
     * A token good for the next minute, renewed if it is not. `rejected` is the
     * token a read was just refused with: a different one already stored means
     * another read renewed it, and that one is used rather than spending the
     * refresh token again.
     */
    private fun accessToken(rejected: String?): Token = synchronized(renewing) {
        val held = session.get() ?: return Token.SignedOut
        val stillGood = clock.millis() < held.expiresAtMs - EXPIRY_MARGIN_MS
        if (rejected == null && stillGood) return Token.Have(held.accessToken)
        if (rejected != null && held.accessToken != rejected) return Token.Have(held.accessToken)

        val clientId = session.clientId() ?: run {
            session.clear()
            return Token.SignedOut
        }
        val form = FormBody.Builder()
            .add("grant_type", "refresh_token")
            .add("refresh_token", held.refreshToken)
            .add("client_id", clientId)
            .build()
        try {
            http.newCall(Request.Builder().url("$root/oauth/token").post(form).build()).execute().use { response ->
                when {
                    response.isSuccessful -> {
                        // Written before it is used: the old refresh token is spent the moment the server answers.
                        val renewed = sessionFrom(response, previousRefresh = held.refreshToken)
                        if (keep(renewed)) {
                            Token.Have(renewed.accessToken)
                        } else {
                            session.clear()
                            Token.SignedOut
                        }
                    }
                    response.code >= 500 -> Token.Offline
                    else -> {
                        // `invalid_grant`: Disconnect was pressed, or the person lost access.
                        session.clear()
                        Token.SignedOut
                    }
                }
            }
        } catch (e: IOException) {
            Token.Offline
        } catch (e: kotlinx.serialization.SerializationException) {
            Token.Offline
        }
    }

    /** Seals and stores a sign-in; false where the phone's key store would not. */
    private fun keep(signedIn: Session): Boolean = try {
        session.save(signedIn)
        true
    } catch (e: Exception) {
        false
    }

    private fun sessionFrom(response: Response, previousRefresh: String?): Session {
        val tokens = Wire.json.decodeFromString<Tokens>(response.body!!.string())
        return Session(
            accessToken = tokens.access_token,
            refreshToken = tokens.refresh_token ?: previousRefresh ?: "",
            expiresAtMs = clock.millis() + tokens.expires_in * 1000,
        )
    }

    private fun errorOf(response: Response): String = try {
        Wire.json.decodeFromString<OAuthError>(response.body!!.string()).error ?: "error ${response.code}"
    } catch (e: Exception) {
        "error ${response.code}"
    }

    @Serializable
    private data class RegistrationBody(
        val redirect_uris: List<String>,
        val token_endpoint_auth_method: String = "none",
        val grant_types: List<String> = listOf("authorization_code", "refresh_token"),
        val response_types: List<String> = listOf("code"),
        val client_name: String = "Cockpit widget",
    )

    companion object {
        private val JSON = "application/json".toMediaType()
        private const val EXPIRY_MARGIN_MS = 60_000L

        /** Never follows a redirect: the token belongs to one origin, and nothing here is meant to be redirected. */
        fun defaultHttp(): OkHttpClient = OkHttpClient.Builder()
            .followRedirects(false)
            .followSslRedirects(false)
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .callTimeout(25, TimeUnit.SECONDS)
            .build()
    }
}
