package expo.modules.smsingest

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LooksLikeMoneyTest {
  private val engine = RepoFiles.engine

  @Test
  fun fixturesAgreeWithTsUnknownVersusNotMoney() {
    var moneyLike = 0
    var notMoney = 0
    for (i in 0 until RepoFiles.fixtures.length()) {
      val f = RepoFiles.fixtures.getJSONObject(i)
      val id = f.getString("id")
      val exp = f.getJSONObject("expected")
      val got = engine.looksLikeMoney(f.getString("sender"), f.getString("body"))
      val want = exp.getBoolean("ok") || exp.optString("reason") == "unknown_template"
      assertEquals("$id (${exp.optString("reason", "ok")})", want, got)
      if (want) moneyLike++ else notMoney++
    }
    assertTrue(moneyLike >= 40)
    assertTrue(notMoney >= 10)
  }

  @Test
  fun otpAndIgnoreAreNotMoney() {
    val body = "123456 is your OTP for IDFC FIRST Bank transaction of INR 500.00 debited. Do not share."
    assertFalse(engine.looksLikeMoney("VM-IDFCFB-S", body))
    assertTrue(engine.isOtp(body))
    assertFalse(engine.isOtp("INR 500.00 debited from your account"))
  }

  @Test
  fun unknownSenderUsesOnlyTheHeuristic() {
    assertTrue(engine.looksLikeMoney("AX-HDFCBK-S", "Rs 1,250.00 debited from HDFC Bank A/c XX1234"))
    assertFalse(engine.looksLikeMoney("AX-HDFCBK-S", "Get 10% cashback, shop now"))
  }

  @Test
  fun versionIsRead() {
    assertEquals(1, engine.version)
  }
}

class MessageClassifierTest {
  private val idfc = "JM-IDFCFB-S"
  private val filter = SenderFilter(listOf("IDFCFB"))
  private val c = MessageClassifier(filter, RepoFiles.engine, engineUsable = true)
  private val credit =
    "Your A/C XXXXX996507 is credited with INR 12,932.00 on 02/09/26 09:13. Your new balance is INR 5,12,932.76. Team IDFC FIRST Bank"

  @Test
  fun moneyIsStoredWithParseForNotification() {
    val d = c.classify(idfc, credit) as Decision.Store
    assertEquals("ca_credit", d.kind)
    assertNotNull(d.parse)
    assertEquals(1293200L, d.parse!!.amountMinor)
  }

  @Test
  fun everyParsableFixtureIsStoredWithItsKind() {
    for (i in 0 until RepoFiles.fixtures.length()) {
      val f = RepoFiles.fixtures.getJSONObject(i)
      val exp = f.getJSONObject("expected")
      val sender = f.getString("sender")
      val d = c.classify(sender, f.getString("body"))
      when {
        !sender.contains("IDFCFB") -> assertEquals(f.getString("id"), Decision.Drop("sender"), d)
        exp.getBoolean("ok") ->
          assertEquals(f.getString("id"), exp.getJSONObject("txn").getString("kind"), (d as Decision.Store).kind)
        exp.getString("reason") == "otp" -> assertEquals(Decision.Drop("otp"), d)
        else -> assertEquals(f.getString("id"), Decision.Drop("not_money"), d)
      }
    }
  }

  @Test
  fun otpIsDropped() {
    assertEquals(
      Decision.Drop("otp"),
      c.classify("VM-IDFCFB-S", "123456 is your OTP for IDFC FIRST Bank transaction of INR 500.00. Do not share."),
    )
  }

  @Test
  fun marketingAndIgnoreTemplatesAreDropped() {
    assertEquals(Decision.Drop("not_money"), c.classify(idfc, "Upgrade to our new card and get 5X rewards! T&C apply"))
    val siNotice =
      "INR 2240.71 for Facebook will be deducted from IDFC FIRST Bank Credit Card XX3455 on 06/11/2026 basis standing instruction (SI)."
    assertEquals(Decision.Drop("not_money"), c.classify(idfc, siNotice))
  }

  @Test
  fun unknownMoneyLikeIsStoredAsUnrecognisedWithoutNotification() {
    val d = c.classify(idfc, "Rs 999.00 debited from your IDFC FIRST Bank account via a brand new channel")
    assertEquals(Decision.Store("unrecognised", null), d)
  }

  @Test
  fun nonMatchingSenderAndNoPatternsDropEverything() {
    assertEquals(Decision.Drop("sender"), c.classify("AX-HDFCBK-S", credit))
    val none = MessageClassifier(SenderFilter(emptyList()), RepoFiles.engine, engineUsable = true)
    assertEquals(Decision.Drop("sender"), none.classify(idfc, credit))
  }

  @Test
  fun unusableEngineStoresUnrecognisedButStillDropsOtp() {
    val bad = MessageClassifier(filter, RepoFiles.engine, engineUsable = false)
    assertEquals(Decision.Store("unrecognised", null), bad.classify(idfc, credit))
    assertEquals(Decision.Drop("otp"), bad.classify(idfc, "123456 is your OTP for login"))
    val noEngine = MessageClassifier(filter, null, engineUsable = false)
    assertEquals(Decision.Store("unrecognised", null), noEngine.classify(idfc, credit))
    assertEquals(Decision.Drop("sender"), noEngine.classify("AX-HDFCBK-S", credit))
  }

  @Test
  fun keepForBackfill() {
    assertTrue(c.keep(idfc, credit))
    assertTrue(c.keep(idfc, "Rs 999.00 debited from your IDFC FIRST Bank account via a brand new channel"))
    assertFalse(c.keep(idfc, "123456 is your OTP for login"))
    assertFalse(c.keep("AX-HDFCBK-S", credit))
  }

  @Test
  fun procedureTestMessageParsesWithAnOverrideSenderPattern() {
    // docs/spike-report.md C: the second handset's number becomes a bank senderPattern via setTemplates.
    val json = org.json.JSONObject(RepoFiles.templateJson)
    json.getJSONArray("banks").getJSONObject(0).put("senderPattern", "TESTPAT")
    val e = TemplateEngine.fromJson(json.toString())!!
    val body = "Your A/c XXXXXXX1234 has been credited with Rs. 100.00 on 08-11-2026. Info: NEFT/TEST/ACME TEST TRADERS. " +
      "New bal: Rs. 1,000.00. Team IDFC FIRST Bank"
    val d = MessageClassifier(SenderFilter(listOf("IDFCFB", "TESTPAT")), e, true).classify("xxTESTPATxx", body) as Decision.Store
    assertEquals("ca_credit", d.kind)
    assertEquals(10000L, d.parse!!.amountMinor)
    assertEquals("1234", d.parse!!.accountLast4)
    assertNull(RepoFiles.engine.parse("xxTESTPATxx", body))
    val tc = MessageClassifier(SenderFilter(listOf("IDFCFB", "TESTPAT")), e, true)
    assertEquals(
      Decision.Store("unrecognised", null),
      tc.classify("xxTESTPATxx", "Rs 50.00 debited from your account via a new channel. Team IDFC FIRST Bank"),
    )
    assertEquals(Decision.Drop("otp"), tc.classify("xxTESTPATxx", "482913 is your OTP for login. Do not share it with anyone."))
    assertEquals(Decision.Drop("not_money"), tc.classify("xxTESTPATxx", "Hello, this is a test message with no money in it"))
    val prodOnly = MessageClassifier(SenderFilter(listOf("IDFCFB")), e, true)
    assertEquals(Decision.Drop("sender"), prodOnly.classify("xxTESTPATxx", body.replace("100.00", "105.00")))
    assertEquals("₹100.00 credited to IDFC First …1234", NotificationText.title(d.parse!!))
  }
}
