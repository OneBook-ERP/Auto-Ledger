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

  override fun rename(key: String, newKey: String): Boolean {
    val v = data.remove(key) ?: return false
    data[newKey] = v
    return true
  }

  override fun keys(): List<String> = data.keys.toList()

  override fun delete(key: String) {
    data.remove(key)
  }
}
