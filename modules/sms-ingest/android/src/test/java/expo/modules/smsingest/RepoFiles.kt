package expo.modules.smsingest

import java.io.File
import org.json.JSONArray

/** Locates templates/idfc.json and fixtures/sms/idfc.json from the Gradle working directory. */
object RepoFiles {
  val root: File by lazy {
    var d: File? = File(System.getProperty("user.dir")).absoluteFile
    while (d != null) {
      if (File(d, "templates/idfc.json").isFile && File(d, "fixtures/sms/idfc.json").isFile) return@lazy d
      d = d.parentFile
    }
    throw IllegalStateException("repo root not found from ${System.getProperty("user.dir")}")
  }
  val templateJson: String by lazy { File(root, "templates/idfc.json").readText() }
  val engine: TemplateEngine by lazy { TemplateEngine.fromJson(templateJson)!! }
  val fixtures: JSONArray by lazy { JSONArray(File(root, "fixtures/sms/idfc.json").readText()) }
}
