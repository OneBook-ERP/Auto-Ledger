package expo.modules.smsingest

import java.util.concurrent.ConcurrentHashMap

/** In-memory [KeyValueStore] for JVM tests. */
class MemoryKeyValueStore : KeyValueStore {
  val data = ConcurrentHashMap<String, String>()
  var writes = 0

  override fun read(key: String): String? = data[key]

  override fun write(key: String, value: String) {
    writes++
    data[key] = value
  }

  override fun quarantine(key: String, stamp: Long): String? {
    val v = data.remove(key) ?: return null
    val name = "$key.corrupt-$stamp"
    data[name] = v
    return name
  }
}
