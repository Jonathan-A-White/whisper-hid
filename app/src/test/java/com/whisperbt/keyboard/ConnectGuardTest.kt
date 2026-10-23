package com.whisperbt.keyboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** A device pick before the HID app is registered must say so (mw-jgcmvd), not "Failed to initiate connection". */
class ConnectGuardTest {
    @Test
    fun `a pick while the HID app is not registered answers not_registered`() {
        assertEquals("not_registered", ConnectGuard.blocker(registered = false))
    }

    @Test
    fun `a pick once registered is let through`() {
        assertNull(ConnectGuard.blocker(registered = true))
    }
}
