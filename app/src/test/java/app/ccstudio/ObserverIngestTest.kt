package app.ccstudio

import org.junit.Assert.assertEquals
import org.junit.Test

class ObserverIngestTest {
    @Test
    fun `cancel は窓の外なら記録`() {
        assertEquals(
            ObserverIngest.Action.RecordCancel,
            ObserverIngest.decide("""{"event":"cancel"}""", 0L, 100_000L),
        )
    }

    @Test
    fun `cancel は窓の内なら重複として捨てる`() {
        assertEquals(
            ObserverIngest.Action.DropDuplicateCancel,
            ObserverIngest.decide("""{"event":"cancel"}""", 100_000L, 100_000L + 14_999L),
        )
    }

    @Test
    fun `cancel は窓ちょうどなら記録（境界は既存実装どおり以上）`() {
        assertEquals(
            ObserverIngest.Action.RecordCancel,
            ObserverIngest.decide(
                """{"event":"cancel"}""",
                100_000L,
                100_000L + ObserverIngest.CANCEL_DEDUP_MS,
            ),
        )
    }

    @Test
    fun `cancel 以外は状態記録`() {
        assertEquals(
            ObserverIngest.Action.RecordState(busy = true, disconnected = false, matched = "stop-btn"),
            ObserverIngest.decide("""{"busy":true,"disconnected":false,"matched":"stop-btn"}""", 0L, 1L),
        )
    }

    @Test
    fun `欠けたフィールドは既定値で状態記録`() {
        assertEquals(
            ObserverIngest.Action.RecordState(busy = false, disconnected = false, matched = ""),
            ObserverIngest.decide("{}", 0L, 1L),
        )
    }

    @Test
    fun `壊れた JSON は無視`() {
        assertEquals(ObserverIngest.Action.Ignore, ObserverIngest.decide("not-json", 0L, 1L))
    }
}
