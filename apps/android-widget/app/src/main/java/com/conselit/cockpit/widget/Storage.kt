package com.conselit.cockpit.widget

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Seals a secret before it is written to the app's private storage, so a copy of
 * that storage (a backup, a rooted phone's file dump) holds nothing a token can be
 * read from. `open` answers null for anything it cannot open, which is how a key
 * the phone has since lost reads: as signed out.
 */
interface SecretBox {
    fun seal(plain: String): String
    fun open(sealed: String): String?
}

/** AES-GCM under a key that never leaves the phone's Keystore. */
class KeystoreSecretBox(private val alias: String = "cockpit-widget-session") : SecretBox {
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    override fun seal(plain: String): String {
        val cipher = Cipher.getInstance(TRANSFORM).apply { init(Cipher.ENCRYPT_MODE, key()) }
        val sealed = cipher.iv + cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(sealed, Base64.NO_WRAP)
    }

    override fun open(sealed: String): String? = try {
        val bytes = Base64.decode(sealed, Base64.NO_WRAP)
        val cipher = Cipher.getInstance(TRANSFORM)
            .apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, bytes, 0, IV_BYTES)) }
        String(cipher.doFinal(bytes, IV_BYTES, bytes.size - IV_BYTES), Charsets.UTF_8)
    } catch (e: Exception) {
        null
    }

    private companion object {
        const val TRANSFORM = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
        const val TAG_BITS = 128
    }
}

/** The sign-in every widget on the phone shares. */
@Serializable
data class Session(val accessToken: String, val refreshToken: String, val expiresAtMs: Long)

/**
 * A sign-in begun and not yet finished: what must be true of the way back. One at a
 * time: asking again while it is fresh reuses it, so the consent the person has open
 * is still the one the app is waiting for.
 */
@Serializable
data class Pending(val state: String, val verifier: String, val closeWhenDone: Boolean, val startedAtMs: Long = 0) {
    /** Whether the person can still be expected to come back to it. */
    fun isFresh(nowMs: Long) = nowMs - startedAtMs in 0..FRESH_MS

    companion object {
        /** An abandoned sign-in is begun afresh after this, so nobody is stuck waiting on one. */
        const val FRESH_MS = 10 * 60 * 1000L
    }
}

/**
 * The token and what the sign-in in flight needs, in the app's private storage,
 * sealed. The registration (`clientId`) is not a secret and is kept as it is.
 */
class SessionStore(context: Context, private val box: SecretBox) {
    private val prefs = context.getSharedPreferences("session", Context.MODE_PRIVATE)

    fun get(): Session? {
        val sealed = prefs.getString(SESSION, null) ?: return null
        val plain = box.open(sealed)
        if (plain == null) {
            clear()
            return null
        }
        return try {
            Wire.json.decodeFromString<Session>(plain)
        } catch (e: Exception) {
            clear()
            null
        }
    }

    fun isSignedIn() = get() != null

    fun save(session: Session) {
        prefs.edit().putString(SESSION, box.seal(Wire.json.encodeToString(session))).apply()
    }

    /** Signs out of this phone. The registration stays: it names this install, not a person. */
    fun clear() {
        prefs.edit().remove(SESSION).remove(PENDING).apply()
    }

    fun clientId(): String? = prefs.getString(CLIENT, null)
    fun saveClientId(id: String) = prefs.edit().putString(CLIENT, id).apply()
    fun forgetClientId() = prefs.edit().remove(CLIENT).apply()

    /** False where the phone's key store would not seal it: a sign-in that cannot be kept safe is not begun. */
    fun savePending(pending: Pending): Boolean = try {
        prefs.edit().putString(PENDING, box.seal(Wire.json.encodeToString(pending))).apply()
        true
    } catch (e: Exception) {
        false
    }

    /** The sign-in in flight. Looking does not spend it: an address that is not its way back, from any app, must not cancel it. */
    fun pending(): Pending? {
        val sealed = prefs.getString(PENDING, null) ?: return null
        val plain = box.open(sealed)
        val pending = plain?.let {
            try {
                Wire.json.decodeFromString<Pending>(it)
            } catch (e: Exception) {
                null
            }
        }
        // One that cannot be read never will be: its secret does not stay on the phone.
        if (pending == null) finishPending()
        return pending
    }

    /** The way back has come: a way back is answered a single time. */
    fun finishPending() {
        prefs.edit().remove(PENDING).apply()
    }

    /** Whether the one-off battery step has been put to the person, whatever they answered. */
    fun batteryStepAsked(): Boolean = prefs.getBoolean(BATTERY, false)
    fun markBatteryStepAsked() = prefs.edit().putBoolean(BATTERY, true).apply()

    private companion object {
        const val SESSION = "session"
        const val PENDING = "pending"
        const val CLIENT = "client-id"
        const val BATTERY = "battery-step-asked"
    }
}

/** Which Panel a widget shows. Ids only, so nothing a person called anything is kept beyond a read. */
@Serializable
data class Binding(val panelId: String, val kind: String, val workspaceId: String)

/** What a widget draws its heading from before, and between, reads. */
@Serializable
data class Header(val panelName: String, val workspaceColor: String)

enum class Problem { PANEL_DELETED, NEEDS_NEWER_VERSION }

/**
 * The last list a widget read, kept for when the next read cannot be made.
 * Wiped at sign-out, along with every name in it.
 */
@Serializable
data class Kept(
    val header: Header,
    val read: PanelRead? = null,
    val updatedAtMs: Long? = null,
    val offline: Boolean = false,
    val problem: Problem? = null,
)

class WidgetStore(context: Context) {
    private val bindings = context.getSharedPreferences("bindings", Context.MODE_PRIVATE)
    private val kept = context.getSharedPreferences("kept", Context.MODE_PRIVATE)

    fun bind(widgetId: Int, binding: Binding) {
        bindings.edit().putString(key(widgetId), Wire.json.encodeToString(binding)).apply()
    }

    fun binding(widgetId: Int): Binding? = bindings.getString(key(widgetId), null)?.let {
        try {
            Wire.json.decodeFromString<Binding>(it)
        } catch (e: Exception) {
            null
        }
    }

    fun forget(widgetId: Int) {
        bindings.edit().remove(key(widgetId)).apply()
        kept.edit().remove(key(widgetId)).apply()
    }

    fun keep(widgetId: Int, value: Kept) {
        kept.edit().putString(key(widgetId), Wire.json.encodeToString(value)).apply()
    }

    fun kept(widgetId: Int): Kept? = kept.getString(key(widgetId), null)?.let {
        try {
            Wire.json.decodeFromString<Kept>(it)
        } catch (e: Exception) {
            null
        }
    }

    /** Every list and every name kept, for sign-out. Which Panel each widget shows stays, so signing in again restores them. */
    fun wipeKept() {
        kept.edit().clear().apply()
    }

    private fun key(widgetId: Int) = "widget-$widgetId"
}
