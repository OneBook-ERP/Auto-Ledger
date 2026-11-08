package expo.modules.smsingest

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/** Minimal string store behind the queue and settings, so the logic runs on the JVM in tests. */
interface KeyValueStore {
  fun read(key: String): String?

  /** Replaces the value atomically: after a crash a reader sees the old or the new value, never a mix. */
  fun write(key: String, value: String)

  /** Moves the value aside under a new name (kept for inspection); returns that name, or null if absent. */
  fun quarantine(key: String, stamp: Long): String?
}

/**
 * One file per key in [dir]. Writes go to `<key>.tmp`, are fsynced, then renamed over the target
 * with ATOMIC_MOVE, so a process kill cannot leave a half-written file. Callers serialise writes.
 */
class FileKeyValueStore(private val dir: File) : KeyValueStore {
  override fun read(key: String): String? {
    val f = File(dir, key)
    return if (f.isFile) f.readText(Charsets.UTF_8) else null
  }

  override fun write(key: String, value: String) {
    if (!dir.isDirectory && !dir.mkdirs()) throw IOException("cannot create $dir")
    val tmp = File(dir, "$key.tmp")
    FileOutputStream(tmp).use {
      it.write(value.toByteArray(Charsets.UTF_8))
      it.fd.sync()
    }
    Files.move(tmp.toPath(), File(dir, key).toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
  }

  override fun quarantine(key: String, stamp: Long): String? {
    val f = File(dir, key)
    if (!f.exists()) return null
    val name = "$key.corrupt-$stamp"
    Files.move(f.toPath(), File(dir, name).toPath(), StandardCopyOption.REPLACE_EXISTING)
    return name
  }
}
