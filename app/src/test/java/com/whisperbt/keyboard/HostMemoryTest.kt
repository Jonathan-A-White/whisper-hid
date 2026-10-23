package com.whisperbt.keyboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Registration reports a "plugged" device that Android knows from another
 * profile (a car's audio link, mw-fxa9j0). It is a keyboard host only when an
 * HID link to it exists.
 */
class HostMemoryTest {
    private val car = "Tesla Model 3 Christian W"
    private val pc = "PF46SGM4"

    @Test
    fun `a plugged device with no HID link is not adopted as the host`() {
        val hosts = HostMemory<String>()

        val adopted = hosts.onRegistered(car) { false }

        assertFalse(adopted)
        assertNull(hosts.connected)
        assertNull(hosts.lastKnown)
    }

    @Test
    fun `a plugged device that is HID-connected is adopted as before`() {
        val hosts = HostMemory<String>()

        val adopted = hosts.onRegistered(pc) { it == pc }

        assertTrue(adopted)
        assertEquals(pc, hosts.connected)
        assertEquals(pc, hosts.lastKnown)
    }

    @Test
    fun `the host he picked stays the reconnect target over a plugged device he never picked`() {
        val hosts = HostMemory<String>()
        hosts.onPick(pc)

        hosts.onRegistered(car) { false }

        assertEquals(pc, hosts.lastKnown)
        assertNull(hosts.connected)
    }

    @Test
    fun `no plugged device leaves the memory alone`() {
        val hosts = HostMemory<String>()
        hosts.onPick(pc)

        assertFalse(hosts.onRegistered(null) { true })

        assertEquals(pc, hosts.lastKnown)
    }
}
