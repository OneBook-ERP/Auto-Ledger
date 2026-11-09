package expo.modules.smsingest

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BackfillQueryTest {
  private val now = 10_000_000_000_000L
  private val day = 86_400_000L

  @Test
  fun zeroDaysMeansNoLowerDateBound() {
    assertNull(BackfillQuery.since(0, now))
    val b = BackfillQuery.bounds(0, now, "date")
    assertNull(b.selection)
    assertNull(b.args)
    assertTrue(BackfillQuery.reads(0))
  }

  @Test
  fun positiveDaysBoundTheDate() {
    assertEquals(now - 7 * day, BackfillQuery.since(7, now))
    val b = BackfillQuery.bounds(7, now, "date")
    assertEquals("date >= ?", b.selection)
    assertArrayEquals(arrayOf((now - 7 * day).toString()), b.args)
  }

  @Test
  fun windowIsCappedAtTenYears() {
    assertEquals(now - 3650 * day, BackfillQuery.since(100_000, now))
  }

  @Test
  fun negativeWindowReadsNothing() {
    assertFalse(BackfillQuery.reads(-1))
  }

  @Test
  fun capIsFiveThousand() {
    assertEquals(5000, BackfillQuery.CAP)
  }
}
