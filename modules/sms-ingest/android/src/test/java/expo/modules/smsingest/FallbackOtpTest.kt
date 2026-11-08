package expo.modules.smsingest

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Item 20B-1: with no usable engine, OTPs must still be dropped (never stored, never backfilled). */
class FallbackOtpTest {
  private val idfc = "JM-IDFCFB-S"
  private val filter = SenderFilter(listOf("IDFCFB"))
  private val noEngine = MessageClassifier(filter, null, engineUsable = false)
  private val credit =
    "Your A/C XXXXX996507 is credited with INR 12,932.00 on 02/09/26 09:13. Your new balance is INR 5,12,932.76. Team IDFC FIRST Bank"

  private val otpForms = listOf(
    "123456 is your OTP for login. Do not share it with anyone.",
    "067219 is the OTP for your IDFC FIRST Bank transaction of INR 500.00. Do not share.",
    "4821 is OTP for txn",
    "123456 as your OTP",
    "Your OTP is 482913. Valid for 10 minutes.",
    "OTP: 482913 for login",
    "OTP for transaction at AMAZON is 772211. Do not share.",
    "One Time Password for your card ending XX3455 is 998877",
    "12345678 is your one-time password",
    "Your one time password is 5566",
    "Your OTP is 482913",
  )

  @Test
  fun everyOtpFixtureBodyIsDroppedWithoutAnEngine() {
    var n = 0
    for (i in 0 until RepoFiles.fixtures.length()) {
      val f = RepoFiles.fixtures.getJSONObject(i)
      if (f.getJSONObject("expected").optString("reason") != "otp") continue
      n++
      val body = f.getString("body")
      assertTrue(f.getString("id"), FallbackOtp.matches(body))
      assertEquals(f.getString("id"), Decision.Drop("otp"), noEngine.classify(f.getString("sender"), body))
      assertFalse(f.getString("id"), noEngine.keep(f.getString("sender"), body))
    }
    assertTrue("at least one otp fixture", n >= 1)
  }

  @Test
  fun everyOtpFormIsDroppedWithoutAnEngine() {
    for (b in otpForms) {
      assertTrue(b, FallbackOtp.matches(b))
      assertEquals(b, Decision.Drop("otp"), noEngine.classify(idfc, b))
      assertFalse(b, noEngine.keep(idfc, b))
    }
  }

  @Test
  fun fallbackAlsoAllowsAnAmountWithDecimalsBeforeTheCode() {
    // The bundled otpPattern stops at the "." of "2,500.00"; the fallback does not.
    assertTrue(FallbackOtp.matches("OTP for transaction of INR 2,500.00 at AMAZON is 772211. Do not share."))
    assertFalse(FallbackOtp.matches("Never share your OTP for any reason. Your balance is 12345."))
  }

  @Test
  fun fallbackAgreesWithTheBundledOtpPatternOnTheseForms() {
    for (b in otpForms) assertTrue(b, RepoFiles.engine.isOtp(b))
  }

  @Test
  fun unusableEngineObjectAlsoGetsTheFallback() {
    val bad = MessageClassifier(filter, RepoFiles.engine, engineUsable = false)
    for (b in otpForms) assertEquals(b, Decision.Drop("otp"), bad.classify(idfc, b))
  }

  @Test
  fun transactionsAreStillStoredWithoutAnEngine() {
    assertEquals(Decision.Store("unrecognised", null), noEngine.classify(idfc, credit))
    // OTP mentioned but no code adjacent: a real alert, keep it.
    assertEquals(Decision.Store("unrecognised", null), noEngine.classify(idfc, "$credit Never share your OTP with anyone."))
    assertEquals(
      Decision.Store("unrecognised", null),
      noEngine.classify(idfc, "Rs 500.00 debited from A/c XX1234. Do not share OTP. Bal Rs 12345.00"),
    )
    // Every non-OTP fixture from a configured sender is kept (nothing silently lost).
    for (i in 0 until RepoFiles.fixtures.length()) {
      val f = RepoFiles.fixtures.getJSONObject(i)
      if (f.getJSONObject("expected").optString("reason") == "otp") continue
      val sender = f.getString("sender")
      if (!sender.contains("IDFCFB")) continue
      assertFalse(f.getString("id"), FallbackOtp.matches(f.getString("body")))
      assertEquals(f.getString("id"), Decision.Store("unrecognised", null), noEngine.classify(sender, f.getString("body")))
    }
  }
}
