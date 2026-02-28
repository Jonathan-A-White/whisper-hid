package com.whisperbt.keyboard

import org.junit.Assert.*
import org.junit.Test

class StateMachineTest {

    @Test
    fun `BtState enum has all expected states`() {
        val states = BluetoothHidService.BtState.entries
        assertEquals(5, states.size)
        assertTrue(states.contains(BluetoothHidService.BtState.IDLE))
        assertTrue(states.contains(BluetoothHidService.BtState.REGISTERED))
        assertTrue(states.contains(BluetoothHidService.BtState.CONNECTED))
        assertTrue(states.contains(BluetoothHidService.BtState.RECONNECTING))
        assertTrue(states.contains(BluetoothHidService.BtState.FAILED))
    }
}
