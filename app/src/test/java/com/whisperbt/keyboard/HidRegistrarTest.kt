package com.whisperbt.keyboard

import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/**
 * The HID app must reach REGISTERED whenever Bluetooth is on, however the
 * first try went: the service used to ask once and then sit in IDLE (status
 * "idle") for good when the proxy never answered, registerApp was refused, or
 * Bluetooth dropped the registration.
 */
class HidRegistrarTest {

    private class FakeProxy(val port: FakePort) : HidRegistrar.Proxy {
        var registerCalls = 0
        var closed = false
        override fun registerApp(): Boolean { registerCalls++; return port.registerAccepts }
        override fun close() { closed = true }
    }

    private class FakePort : HidRegistrar.Port {
        var on = true
        var proxyAccepted = true
        var registerAccepts = true
        val requests = mutableListOf<HidRegistrar.ProxyListener>()
        val proxies = mutableListOf<FakeProxy>()
        override fun bluetoothOn() = on
        override fun requestProxy(listener: HidRegistrar.ProxyListener): Boolean {
            requests.add(listener)
            return proxyAccepted
        }
        /** The Bluetooth stack answers the newest request. */
        fun answer(): FakeProxy {
            val p = FakeProxy(this)
            proxies.add(p)
            requests.last().onConnected(p)
            return p
        }
    }

    private lateinit var port: FakePort
    private lateinit var registrar: HidRegistrar
    private var clock = 0L
    private val scheduled = mutableListOf<Long>()
    private var timerArmed = false
    private val logs = mutableListOf<Pair<String, String>>()

    @Before
    fun setUp() {
        port = FakePort()
        registrar = HidRegistrar(
            port,
            schedule = { scheduled.add(it); timerArmed = true },
            cancelTimer = { timerArmed = false },
            now = { clock },
            log = { level, msg -> logs.add(level to msg) }
        )
    }

    /** The retry timer fires. */
    private fun fire() {
        timerArmed = false
        registrar.onRetryTimer()
    }

    @Test
    fun `starting registers once the proxy answers and registration lands`() {
        registrar.ensureRegistered()
        assertEquals(1, port.requests.size)
        val p = port.answer()
        assertEquals(1, p.registerCalls)
        registrar.onAppStatus(true)
        assertTrue(registrar.registered)
        assertFalse("no retry once registered", timerArmed)
    }

    @Test
    fun `a refused proxy request is retried on the reconnect schedule until it registers`() {
        port.proxyAccepted = false
        registrar.ensureRegistered()
        assertTrue(timerArmed)
        assertEquals(listOf(2_000L), scheduled)
        clock += 2_000
        fire()
        assertEquals(listOf(2_000L, 4_000L), scheduled)
        port.proxyAccepted = true
        clock += 4_000
        fire()
        port.answer()
        registrar.onAppStatus(true)
        assertTrue(registrar.registered)
        assertFalse(timerArmed)
    }

    @Test
    fun `a proxy that never answers is asked for again`() {
        registrar.ensureRegistered()
        clock += 2_000
        fire()
        assertEquals("a second request", 2, port.requests.size)
        port.answer()
        registrar.onAppStatus(true)
        assertTrue(registrar.registered)
    }

    @Test
    fun `registerApp refused is retried`() {
        port.registerAccepts = false
        registrar.ensureRegistered()
        port.answer()
        assertTrue(timerArmed)
        port.registerAccepts = true
        clock += 2_000
        fire()
        val p = port.answer()
        assertEquals(1, p.registerCalls)
        registrar.onAppStatus(true)
        assertTrue(registrar.registered)
    }

    @Test
    fun `a registration Bluetooth reports as failed is retried`() {
        registrar.ensureRegistered()
        port.answer()
        registrar.onAppStatus(false)
        assertFalse(registrar.registered)
        assertTrue(timerArmed)
        clock += 2_000
        fire()
        port.answer()
        registrar.onAppStatus(true)
        assertTrue(registrar.registered)
    }

    @Test
    fun `a registration dropped after it landed is retried`() {
        registrar.ensureRegistered()
        port.answer()
        registrar.onAppStatus(true)
        registrar.onAppStatus(false)
        assertTrue(timerArmed)
        clock += 2_000
        fire()
        port.answer()
        registrar.onAppStatus(true)
        assertTrue(registrar.registered)
    }

    @Test
    fun `a proxy that disconnects and reconnects registers again`() {
        registrar.ensureRegistered()
        val listener = port.requests.last()
        val first = FakeProxy(port)
        listener.onConnected(first)
        registrar.onAppStatus(true)
        listener.onDisconnected()
        assertFalse(registrar.registered)
        assertTrue("retry armed while the proxy is away", timerArmed)
        val second = FakeProxy(port)
        listener.onConnected(second)
        assertEquals("registers on the proxy reconnect", 1, second.registerCalls)
        registrar.onAppStatus(true)
        assertTrue(registrar.registered)
        assertFalse(timerArmed)
    }

    @Test
    fun `Bluetooth off at start asks for nothing and stops the retries`() {
        port.on = false
        registrar.ensureRegistered()
        assertEquals(0, port.requests.size)
        assertFalse(timerArmed)
        // adapter turns on
        port.on = true
        registrar.ensureRegistered()
        assertEquals(1, port.requests.size)
        port.answer()
        registrar.onAppStatus(true)
        assertTrue(registrar.registered)
    }

    @Test
    fun `Bluetooth switched off cancels the retries and a stale proxy is ignored`() {
        registrar.ensureRegistered()
        val stale = port.requests.last()
        registrar.onBluetoothOff()
        assertFalse(timerArmed)
        assertFalse(registrar.registered)
        val late = FakeProxy(port)
        stale.onConnected(late)
        assertEquals("a stale proxy must not register", 0, late.registerCalls)
        // the timer firing after the adapter went off does nothing
        port.on = false
        fire()
        assertEquals(1, port.requests.size)
        assertFalse(timerArmed)
    }

    @Test
    fun `the timer firing with Bluetooth off gives up until the adapter comes on`() {
        port.proxyAccepted = false
        registrar.ensureRegistered()
        port.on = false
        clock += 2_000
        fire()
        assertFalse(timerArmed)
        assertEquals(1, port.requests.size)
    }

    @Test
    fun `retries follow ReconnectPolicy and never stop while Bluetooth is on`() {
        port.proxyAccepted = false
        registrar.ensureRegistered()
        repeat(14) {
            clock += scheduled.last()
            fire()
            assertTrue("still armed after retry ${it + 1}", timerArmed)
        }
        // after five minutes the delay is the slow one
        assertEquals(ReconnectPolicy.SLOW_DELAY_MS, scheduled.last())
        assertEquals(listOf(2_000L, 4_000L, 8_000L, 16_000L, 30_000L, 30_000L), scheduled.take(6))
    }

    @Test
    fun `shutdown closes the proxy and cancels the timer`() {
        port.proxyAccepted = true
        registrar.ensureRegistered()
        val p = port.answer()
        registrar.shutdown()
        assertTrue(p.closed)
        assertFalse(timerArmed)
        assertFalse(registrar.registered)
        // Bluetooth's late "unregistered" answer must not start retrying a dead service
        registrar.onAppStatus(false)
        assertFalse(timerArmed)
    }

    @Test
    fun `restart drops the old registration and registers again`() {
        registrar.ensureRegistered()
        val first = port.answer()
        registrar.onAppStatus(true)
        registrar.restart()
        assertTrue(first.closed)
        assertFalse(registrar.registered)
        assertEquals(2, port.requests.size)
        port.answer()
        registrar.onAppStatus(true)
        assertTrue(registrar.registered)
    }

    // --- Android takes registerApp and never calls back (mw-jgcmvd) ---

    @Test
    fun `each unanswered registerApp is logged with its attempt and the wait`() {
        registrar.ensureRegistered()
        port.answer() // registerApp accepted, Bluetooth never calls back
        clock += 2_000
        fire()
        assertTrue(
            logs.toString(),
            logs.contains("error" to "No answer from Bluetooth to registerApp (attempt 1, waited 2 s)")
        )
        port.answer()
        clock += 4_000
        fire()
        assertTrue(
            logs.toString(),
            logs.contains("error" to "No answer from Bluetooth to registerApp (attempt 2, waited 4 s)")
        )
        assertTrue("still retrying", timerArmed)
    }

    @Test
    fun `an answered registerApp logs no silence line`() {
        registrar.ensureRegistered()
        port.answer()
        registrar.onAppStatus(false)
        clock += 2_000
        fire()
        assertTrue(logs.toString(), logs.none { it.second.startsWith("No answer") })
    }

    @Test
    fun `a proxy that never answers is logged too`() {
        registrar.ensureRegistered()
        clock += 2_000
        fire()
        assertTrue(
            logs.toString(),
            logs.contains("error" to "No answer from Bluetooth to the HID profile request (attempt 1, waited 2 s)")
        )
    }

    @Test
    fun `three unanswered attempts make Bluetooth not answering`() {
        assertFalse(registrar.notAnswering)
        registrar.ensureRegistered()
        repeat(3) {
            assertFalse("after $it unanswered", registrar.notAnswering)
            port.answer()
            clock += scheduled.last()
            fire()
        }
        assertTrue(registrar.notAnswering)
    }

    @Test
    fun `an answer clears Bluetooth not answering`() {
        registrar.ensureRegistered()
        repeat(3) {
            port.answer()
            clock += scheduled.last()
            fire()
        }
        assertTrue(registrar.notAnswering)
        port.answer()
        registrar.onAppStatus(true)
        assertFalse(registrar.notAnswering)
    }

    @Test
    fun `Restart HID keeps the not answering verdict until Bluetooth answers`() {
        registrar.ensureRegistered()
        repeat(3) {
            port.answer()
            clock += scheduled.last()
            fire()
        }
        registrar.restart()
        assertTrue(registrar.notAnswering)
    }

    @Test
    fun `every registration path logs its outcome`() {
        registrar.ensureRegistered()
        assertTrue(logs.toString(), logs.any { it.second.startsWith("Registering the HID app (attempt 1") })
        port.answer()
        assertTrue(logs.toString(), logs.any { it.second.startsWith("registerApp accepted") })
        port.on = false
        clock += 2_000
        fire()
        assertTrue(logs.toString(), logs.any { it.second.contains("Bluetooth is off") })
    }
}
