package com.whisperbt.keyboard

import com.whisperbt.keyboard.BluetoothHidService.BtState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The host link state machine against a fake HID profile. Device names stand
 * in for BluetoothDevices. Callbacks are delivered by the test, as the HID
 * executor would: a disconnect() of a linked host comes back as a
 * DISCONNECTED callback, and a connect attempt that does not come up is
 * reported as DISCONNECTED for that device.
 */
class HostLinkTest {
    private val pc = "PF46SGM4"
    private val home = "DESKTOP-GPDSTK0"
    private val headset = "PLT Focus"
    private val car = "Tesla Model 3 Christian W"

    private class FakeHid(vararg bonded: String) : HostLink.Port<String> {
        var bonded = bonded.toList()
        val linked = mutableSetOf<String>()
        val connects = mutableListOf<String>()
        val disconnects = mutableListOf<String>()
        val logs = mutableListOf<String>()
        val notes = mutableListOf<String>()
        val remembered = mutableListOf<String>()
        var linkDowns = 0
        var armed: Long? = null
        var clock = 1_000_000L
        private val callbacks = mutableListOf<(HostLink<String>) -> Unit>()

        override fun bluetoothOn() = true
        override fun bondedDevices(): Collection<String> = bonded
        override fun hidLinked(device: String) = device in linked
        override fun hidLinkedHosts(): List<String> = linked.toList()
        override fun connect(device: String): Boolean { connects += device; return true }
        override fun disconnect(device: String) {
            disconnects += device
            if (linked.remove(device)) callbacks += { it.onDisconnected(device) }
        }
        override fun name(device: String?) = device ?: "Unknown"
        override fun now() = clock
        override fun scheduleRetry(delayMs: Long) { armed = delayMs }
        override fun cancelRetry() { armed = null }
        override fun log(level: String, message: String) { logs += message }
        override fun notify(status: String) { notes += status }
        override fun onLinkUp() {}
        override fun onLinkDown() { linkDowns++ }
        override fun onBluetoothOff() {}
        override fun remember(device: String) { remembered += device }

        /** Run the callbacks the stack owes for what was called. */
        fun deliver(link: HostLink<String>) {
            val due = callbacks.toList()
            callbacks.clear()
            due.forEach { it(link) }
        }

        /** The retry timer fires. */
        fun fire(link: HostLink<String>) {
            assertNotNull("the retry timer is armed", armed)
            clock += armed!!
            armed = null
            link.onRetryTimer()
        }

        /** [device] (the host, or us) brings an HID link up. */
        fun linkUp(link: HostLink<String>, device: String) {
            linked += device
            link.onConnected(device)
        }

        /** The connect attempt to [device] does not come up. */
        fun connectFails(link: HostLink<String>, device: String) = link.onDisconnected(device)

        fun logged(prefix: String) = logs.count { it.startsWith(prefix) }
    }

    @Test
    fun `his sequence - picking the host that is already connected keeps the link`() {
        val hid = FakeHid(headset, home, pc)
        val link = HostLink(hid)
        link.onRegistered(headset)
        hid.linkUp(link, pc)
        hid.logs.clear()

        link.pick(pc)
        hid.deliver(link)

        assertEquals(BtState.CONNECTED, link.state)
        assertEquals(pc, link.connected)
        assertEquals(emptyList<String>(), hid.disconnects)
        assertEquals(0, hid.logged("Switching to device"))
        assertEquals(0, hid.logged("BT disconnected"))
        assertEquals(0, hid.logged("Reconnect attempt"))
        assertNull("no new reconnect cycle", hid.armed)
        assertEquals(0, hid.linkDowns)
    }

    @Test
    fun `his log - a pick while reconnecting keeps the retries going past attempt 1`() {
        // Registered; connected to the home PC; he picks PF46SGM4; it does not
        // come up, he picks it again, it does not come up again.
        val hid = FakeHid(home, pc)
        val link = HostLink(hid)
        link.onRegistered(headset)
        hid.linkUp(link, home)

        assertEquals(HostLink.Pick.SWITCHING, link.pick(pc))
        hid.deliver(link)
        hid.fire(link)
        hid.connectFails(link, pc)
        link.pick(pc)
        hid.connectFails(link, pc)

        assertEquals(BtState.RECONNECTING, link.state)
        assertNotNull("still retrying", hid.armed)
        hid.fire(link)
        assertEquals(2, link.reconnectAttempt)
        assertEquals(pc, hid.connects.last())
    }

    @Test
    fun `the attempt counter rises across failed attempts and resets only on a real connection`() {
        val hid = FakeHid(pc)
        val link = HostLink(hid)
        link.onRegistered(headset)
        assertEquals(1, link.reconnectAttempt)
        hid.connectFails(link, pc)
        hid.fire(link)
        hid.connectFails(link, pc)
        hid.fire(link)
        assertEquals(3, link.reconnectAttempt)

        // The host's link appeared (ACL broadcast): try now, keep counting.
        link.startReconnect(immediate = true)
        assertEquals(4, link.reconnectAttempt)
        assertTrue(hid.notes.last().startsWith("Reconnecting… (attempt 5"))

        hid.linkUp(link, pc)
        assertEquals(0, link.reconnectAttempt)
        hid.disconnect(pc)
        hid.deliver(link)
        hid.fire(link)
        assertEquals(1, link.reconnectAttempt)
    }

    @Test
    fun `a stale connect to another device closing does not drop the connected host`() {
        val hid = FakeHid(home, pc)
        val link = HostLink(hid)
        link.onRegistered(headset)
        hid.linkUp(link, pc)

        hid.connectFails(link, home)

        assertEquals(BtState.CONNECTED, link.state)
        assertEquals(pc, link.connected)
        assertEquals(0, hid.linkDowns)
        assertEquals(0, hid.logged("BT disconnected"))
        assertNull(hid.armed)
    }

    @Test
    fun `a host whose HID link is already up is taken at registration instead of dialled`() {
        // Windows shows the phone Connected: the HID link is up, but the
        // plugged device Android reports is the headset.
        val hid = FakeHid(headset, home, pc)
        hid.linked += pc
        val link = HostLink(hid)

        link.onRegistered(headset)

        assertEquals(BtState.CONNECTED, link.state)
        assertEquals(pc, link.connected)
        assertEquals(emptyList<String>(), hid.connects)
    }

    @Test
    fun `picking a host whose HID link is up while reconnecting takes it`() {
        val hid = FakeHid(home, pc)
        val link = HostLink(hid)
        link.onRegistered(headset)
        hid.connectFails(link, home)
        hid.linked += pc // Windows dialled in; the callback never came

        link.pick(pc)

        assertEquals(BtState.CONNECTED, link.state)
        assertEquals(pc, link.connected)
        assertEquals(emptyList<String>(), hid.disconnects)
        assertEquals(0, hid.logged("Switching to device"))
        assertNull(hid.armed)
    }

    @Test
    fun `a pick of another computer switches to it`() {
        val hid = FakeHid(home, pc)
        val link = HostLink(hid)
        link.onRegistered(headset)
        hid.linkUp(link, home)

        assertEquals(HostLink.Pick.SWITCHING, link.pick(pc))
        hid.deliver(link)

        assertEquals(listOf(home), hid.disconnects)
        assertEquals(1, hid.logged("Switching to device: $pc"))
        assertEquals(pc, link.lastKnown)
        assertEquals(1, hid.linkDowns)
        hid.linkUp(link, pc)
        assertEquals(pc, link.connected)
        assertEquals(BtState.CONNECTED, link.state)
    }

    @Test
    fun `with only a car linked, registration does not claim it is connected`() {
        val hid = FakeHid(car)
        val link = HostLink(hid)

        link.onRegistered(car)

        assertFalse(link.state == BtState.CONNECTED)
        assertNull(link.connected)
        assertEquals(0, hid.logged("Already connected"))
    }

    @Test
    fun `the host it last connected to is remembered and is the first one tried after a restart`() {
        val hid = FakeHid(home, pc)
        val link = HostLink(hid)
        link.onRegistered(headset)
        hid.linkUp(link, pc)
        assertEquals(listOf(pc), hid.remembered)

        val next = FakeHid(home, pc)
        val restarted = HostLink(next)
        restarted.restore(pc)
        restarted.onRegistered(headset)

        assertEquals(listOf(pc), next.connects)
    }
}
