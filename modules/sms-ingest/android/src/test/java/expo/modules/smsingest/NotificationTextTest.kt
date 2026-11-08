package expo.modules.smsingest

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class NotificationTextTest {
  private fun p(kind: String, dir: String, minor: Long, cur: String = "INR", last4: String? = null) =
    NativeParse(kind, dir, minor, cur, last4)

  @Test
  fun indianGrouping() {
    assertEquals("₹0.00", NotificationText.amount(0, "INR"))
    assertEquals("₹0.05", NotificationText.amount(5, "INR"))
    assertEquals("₹466.47", NotificationText.amount(46647, "INR"))
    assertEquals("₹1,000.00", NotificationText.amount(100000, "INR"))
    assertEquals("₹12,932.00", NotificationText.amount(1293200, "INR"))
    assertEquals("₹75,000.00", NotificationText.amount(7500000, "INR"))
    assertEquals("₹1,30,000.00", NotificationText.amount(13000000, "INR"))
    assertEquals("₹5,12,932.76", NotificationText.amount(51293276, "INR"))
    assertEquals("₹12,34,56,789.01", NotificationText.amount(123456789_01L, "INR"))
  }

  @Test
  fun otherCurrencies() {
    assertEquals("USD 100.00", NotificationText.amount(10000, "USD"))
    assertEquals("USD 94.36", NotificationText.amount(9436, "USD"))
    assertEquals("USD 1,234,567.00", NotificationText.amount(123456700, "USD"))
  }

  @Test
  fun creditWithLast4() {
    assertEquals("₹12,932.00 credited to IDFC First …6507", NotificationText.title(p("ca_credit", "in", 1293200, last4 = "6507")))
  }

  @Test
  fun debitWithoutLast4() {
    assertEquals("₹75,000.00 debited from IDFC First", NotificationText.title(p("ca_debit", "out", 7500000)))
  }

  @Test
  fun cardSpendAndUsd() {
    assertEquals("₹466.47 spent on IDFC card …3455", NotificationText.title(p("card_spend", "out", 46647, last4 = "3455")))
    assertEquals("USD 94.36 spent on IDFC card …3455", NotificationText.title(p("card_spend", "out", 9436, "USD", "3455")))
  }

  @Test
  fun otherKinds() {
    assertEquals("₹2,240.71 paid by standing instruction on IDFC card …3455",
      NotificationText.title(p("card_si_paid", "out", 224071, last4 = "3455")))
    assertEquals("₹30,000.00 sent by NEFT from IDFC First", NotificationText.title(p("neft_confirm", "out", 3000000)))
    assertEquals("₹1.00 received in IDFC First", NotificationText.title(p("something_new", "in", 100)))
    assertEquals("₹1.00 paid from IDFC First", NotificationText.title(p("something_new", "out", 100)))
  }

  @Test
  fun everyFixtureTitleHasNoBodyText() {
    for (i in 0 until RepoFiles.fixtures.length()) {
      val f = RepoFiles.fixtures.getJSONObject(i)
      val r = RepoFiles.engine.parse(f.getString("sender"), f.getString("body")) ?: continue
      val title = NotificationText.title(r)
      assertTrue(title, title.startsWith(if (r.currency == "INR") "₹" else "${r.currency} "))
      assertFalse(title, title.contains("Team IDFC") || title.contains("balance", ignoreCase = true))
    }
  }

  @Test
  fun notificationIdIsStableAndNonNegative() {
    val a = NotificationText.notificationId("1700000000000-1")
    assertEquals(a, NotificationText.notificationId("1700000000000-1"))
    assertNotEquals(a, NotificationText.notificationId("1700000000000-2"))
    assertTrue(a >= 0)
    assertTrue((1..2000).map { NotificationText.notificationId("1700000000000-$it") }.all { it >= 0 })
  }
}
