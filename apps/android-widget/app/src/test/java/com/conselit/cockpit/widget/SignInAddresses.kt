package com.conselit.cockpit.widget

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Home-screen widget: one sign-in serves every widget on the phone. The arithmetic
 * and the addresses of signing in, which hold the token back from anything that
 * did not start the sign-in (A1).
 */
class SignInAddresses {
    private val origin = "https://cockpit.vanhoutte-michael.workers.dev"
    private val redirect = "cockpit-widget://oauth"

    @Test
    fun `the proof sent in place of the secret is its S256 hash, as RFC 7636 works it out`() {
        assertEquals(
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
            Pkce.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
        )
    }

    @Test
    fun `every sign-in gets a secret and a state of its own`() {
        assertNotEquals(Pkce.verifier(), Pkce.verifier())
        assertNotEquals(Pkce.state(), Pkce.state())
        assertTrue(Pkce.verifier().length >= 43)
    }

    @Test
    fun `the browser is sent to Cockpit asking to read Panels only, for the apps resource and no scope`() {
        val address = SignInAddress.authorize(origin, "client-1", redirect, "state-1", "challenge-1")
        assertEquals(
            "$origin/oauth/authorize?response_type=code&client_id=client-1" +
                "&redirect_uri=cockpit-widget%3A%2F%2Foauth&state=state-1&code_challenge=challenge-1" +
                "&code_challenge_method=S256&resource=https%3A%2F%2Fcockpit.vanhoutte-michael.workers.dev%2Fapps",
            address,
        )
        assertTrue("scope" !in address)
    }

    @Test
    fun `the way back is taken only when it answers this sign-in`() {
        val back = { address: String -> SignInAddress.parseBack(address, "state-1", origin) }
        assertEquals(SignInAddress.Back.Code("abc"), back("$redirect?code=abc&state=state-1&iss=$origin"))
        assertEquals(SignInAddress.Back.Code("a b"), back("$redirect?code=a%20b&state=state-1"))
        assertEquals(SignInAddress.Back.Unexpected, back("$redirect?code=abc&state=another"))
        assertEquals(SignInAddress.Back.Unexpected, back("$redirect?code=abc"))
        assertEquals(SignInAddress.Back.Unexpected, back("$redirect?code=abc&state=state-1&iss=https://elsewhere.example"))
        assertEquals(SignInAddress.Back.Unexpected, back("$redirect?state=state-1"))
        assertEquals(SignInAddress.Back.Refused("access_denied"), back("$redirect?error=access_denied&state=state-1"))
    }
}