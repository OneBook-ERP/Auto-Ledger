package expo.modules.smsingest

import java.io.File
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Conformance: the Kotlin engine must agree with the TS parser on templates/idfc.json + fixtures/sms/idfc.json. */
class TemplateEngineTest {
  private fun repoRoot(): File {
    var d: File? = File(System.getProperty("user.dir")).absoluteFile
    while (d != null) {
      if (File(d, "templates/idfc.json").isFile && File(d, "fixtures/sms/idfc.json").isFile) return d
      d = d.parentFile
    }
    throw IllegalStateException("repo root not found from ${System.getProperty("user.dir")}")
  }

  private val templateJson: String by lazy { File(repoRoot(), "templates/idfc.json").readText() }
  private val engine: TemplateEngine by lazy { TemplateEngine.fromJson(templateJson)!! }
  private val idfc = "JM-IDFCFB-S"
  private val creditBody =
    "Your A/C XXXXX996507 is credited with INR 12,932.00 on 02/09/26 09:13. Your new balance is INR 5,12,932.76. Team IDFC FIRST Bank"

  @Test
  fun everyFixtureAgreesWithExpected() {
    val fixtures = JSONArray(File(repoRoot(), "fixtures/sms/idfc.json").readText())
    assertTrue(fixtures.length() >= 50)
    for (i in 0 until fixtures.length()) {
      val f = fixtures.getJSONObject(i)
      val id = f.getString("id")
      val exp = f.getJSONObject("expected")
      val r = engine.parse(f.getString("sender"), f.getString("body"))
      if (!exp.getBoolean("ok")) {
        assertNull("$id should be null (${exp.optString("reason")})", r)
        continue
      }
      assertNotNull("$id should parse", r)
      val t = exp.getJSONObject("txn")
      if (t.has("kind")) assertEquals("$id kind", t.getString("kind"), r!!.kind)
      if (t.has("direction")) assertEquals("$id direction", t.getString("direction"), r!!.direction)
      if (t.has("amountMinor")) assertEquals("$id amountMinor", t.getLong("amountMinor"), r!!.amountMinor)
      if (t.has("currency")) assertEquals("$id currency", t.getString("currency"), r!!.currency)
      if (t.has("accountLast4")) {
        val want = if (t.isNull("accountLast4")) null else t.getString("accountLast4")
        assertEquals("$id accountLast4", want, r!!.accountLast4)
      }
    }
  }

  @Test
  fun narrowedOtpRule() {
    val r = engine.parse(idfc, "$creditBody Never share your OTP with anyone.")
    assertNotNull(r)
    assertEquals(1293200L, r!!.amountMinor)
    assertNull(engine.parse(idfc, "067219 is the OTP for your IDFC FIRST Bank transaction of INR 500.00. Do not share."))
    assertNull(engine.parse(idfc, "067219 is the OTP for txn"))
  }

  @Test
  fun nbspIsNormalised() {
    val r = engine.parse(idfc, creditBody.replace("credited with INR 12", "credited with INR 12"))
    assertNotNull(r)
    assertEquals(1293200L, r!!.amountMinor)
  }

  @Test
  fun nbspBodyGivesSameParseAsPlain() {
    val nb = creditBody.replace("credited with INR 12", "credited\u00A0with\u202FINR\u00A012")
    assertNotEquals(creditBody, nb)
    assertEquals(engine.parse(idfc, creditBody), engine.parse(idfc, nb))
    assertNotNull(engine.parse(idfc, nb))
  }

  @Test
  fun selfTestPasses() {
    assertTrue(TemplateEngine.selfTest())
  }

  @Test
  fun degenerateRequiredPatternsAreRejected() {
    for (k in listOf("otpPattern", "moneyVerbPattern", "amountPattern")) {
      for (v in listOf("|", "x*", "   ", "")) {
        val j = JSONObject(templateJson).put(k, v).toString()
        assertNull("$k=\"$v\"", TemplateEngine.fromJson(j))
      }
    }
  }

  @Test
  fun unknownSenderIsNull() {
    assertNull(engine.parse("AX-HDFCBK-S", creditBody))
  }

  @Test
  fun malformedBodiesAreNullNotThrown() {
    assertNull(engine.parse(idfc, creditBody.replace("02/09/26", "02/Zzz/26")))
    assertNull(engine.parse(idfc, creditBody.replace("02/09/26", "32/09/26")))
    assertNull(engine.parse(idfc, creditBody.replace("02/09/26", "02/13/26")))
    assertNull(engine.parse(idfc, creditBody.replace("INR 12,932.00", "INR ,")))
    assertNull(engine.parse(idfc, ""))
  }

  @Test
  fun malformedTemplateSetsAreRejected() {
    val base = JSONObject(templateJson)
    fun without(k: String) = JSONObject(base.toString()).also { it.remove(k) }.toString()
    for (k in listOf("otpPattern", "moneyVerbPattern", "amountPattern", "banks")) {
      assertNull("missing $k", TemplateEngine.fromJson(without(k)))
    }
    fun with(k: String, v: Any) = JSONObject(base.toString()).also { it.put(k, v) }.toString()
    assertNull(TemplateEngine.fromJson(with("otpPattern", "")))
    assertNull(TemplateEngine.fromJson(with("otpPattern", "(unclosed")))
    assertNull(TemplateEngine.fromJson(with("banks", JSONArray())))
    val badTpl = JSONObject(base.toString())
    badTpl.getJSONArray("banks").getJSONObject(0).getJSONArray("templates").getJSONObject(0).put("regex", "[")
    assertNull(TemplateEngine.fromJson(badTpl.toString()))
    assertNull(TemplateEngine.fromJson("not json"))
    assertNull(TemplateEngine.fromJson(""))
  }
}
