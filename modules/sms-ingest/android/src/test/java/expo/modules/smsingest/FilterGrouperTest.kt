package expo.modules.smsingest

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SenderFilterTest {
  @Test
  fun noPatternsMatchesNothing() {
    val f = SenderFilter(emptyList())
    assertFalse(f.matches("JM-IDFCFB-S"))
    assertFalse(f.matches(""))
  }

  @Test
  fun blankPatternsAreIgnored() {
    val f = SenderFilter(listOf("", "   "))
    assertFalse(f.matches("JM-IDFCFB-S"))
    assertFalse(f.hasPatterns)
  }

  @Test
  fun substringMatchCaseInsensitive() {
    val f = SenderFilter(listOf("IDFCFB"))
    assertTrue(f.matches("JM-IDFCFB-S"))
    assertTrue(f.matches("ax-idfcfb-t"))
    assertFalse(f.matches("AX-HDFCBK-S"))
    assertFalse(f.matches(""))
  }

  @Test
  fun anyOfSeveralPatterns() {
    val f = SenderFilter(listOf("IDFCFB", " TESTPAT "))
    assertTrue(f.matches("xxTESTPATyy"))
    assertTrue(f.matches("VM-IDFCFB-S"))
    assertFalse(f.matches("VM-HDFCBK"))
  }
}

class MultipartGrouperTest {
  @Test
  fun partsOfOneSenderAreJoinedInOrder() {
    val out = MultipartGrouper.group(
      listOf(SmsPart("JM-IDFCFB-S", "Hello ", 100L), SmsPart("JM-IDFCFB-S", "world", 101L)),
    )
    assertEquals(listOf(GroupedSms("JM-IDFCFB-S", "Hello world", 100L)), out)
  }

  @Test
  fun twoSendersInOneIntentStaySeparate() {
    val out = MultipartGrouper.group(
      listOf(
        SmsPart("A", "a1", 1L),
        SmsPart("B", "b1", 5L),
        SmsPart("A", "a2", 2L),
        SmsPart("B", "b2", 6L),
      ),
    )
    assertEquals(listOf(GroupedSms("A", "a1a2", 1L), GroupedSms("B", "b1b2", 5L)), out)
  }

  @Test
  fun nullAddressAndBodyAreSafe() {
    val out = MultipartGrouper.group(listOf(SmsPart(null, null, 3L), SmsPart(null, "x", 4L)))
    assertEquals(listOf(GroupedSms("", "x", 3L)), out)
    assertEquals(emptyList<GroupedSms>(), MultipartGrouper.group(emptyList()))
  }
}
