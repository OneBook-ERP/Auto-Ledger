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
  fun lockScreenPublicVersionNeverCarriesSmsDetail() {
    assertEquals("AutoLedger", NotificationText.PUBLIC_TITLE)
    assertEquals("New bank transaction", NotificationText.PUBLIC_TEXT)
    assertEquals("Tap to classify", NotificationText.PRIVATE_TEXT)
    val pub = NotificationText.PUBLIC_TITLE + " " + NotificationText.PUBLIC_TEXT
    assertFalse(pub, pub.any { it.isDigit() })
    assertFalse(pub, pub.contains("₹") || pub.contains("IDFCFB") || pub.contains("INR"))
    for (i in 0 until RepoFiles.fixtures.length()) {
      val f = RepoFiles.fixtures.getJSONObject(i)
      val r = RepoFiles.engine.parse(f.getString("sender"), f.getString("body")) ?: continue
      assertFalse(pub.contains(f.getString("sender")))
      r.accountLast4?.let { assertFalse(pub.contains(it)) }
      assertFalse(f.getString("body").contains(pub))
    }
  }

  @Test
  fun notificationIdComesFromTheQueueSeq() {
    assertEquals(1, NotificationText.notificationId(1L))
    assertEquals(42, NotificationText.notificationId(42L))
    assertEquals(Int.MAX_VALUE, NotificationText.notificationId(Int.MAX_VALUE.toLong()))
    // Wraps into 1..Int.MAX_VALUE, never 0 or negative.
    assertEquals(1, NotificationText.notificationId(Int.MAX_VALUE.toLong() + 1))
    assertTrue(NotificationText.notificationId(0L) > 0)
    assertTrue(NotificationText.notificationId(Long.MAX_VALUE) > 0)
    assertNotEquals(NotificationText.notificationId(7L), NotificationText.notificationId(8L))
  }

}
