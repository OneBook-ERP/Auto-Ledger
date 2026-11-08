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

  /** Moves [key]'s value to [newKey], replacing it; false if [key] is absent. */
  fun rename(key: String, newKey: String): Boolean

  /** Every key currently stored. */
  fun keys(): List<String>

  /** Removes [key] (no-op if absent). */
  fun delete(key: String)
}

/**
 * Moves the value aside as `<key>.corrupt-<stamp>` (kept for inspection) and returns that name,
 * or null if absent. Quarantined values can hold raw SMS text, so this also prunes: only the
 * newest quarantined copy of each key is kept, and none older than [Quarantine.MAX_AGE_MS]
 * ([stamp] is the caller's clock reading, used as "now").
 */
fun KeyValueStore.quarantine(key: String, stamp: Long): String? {
  val name = "$key${Quarantine.MARK}$stamp"
  if (!rename(key, name)) return null
  Quarantine.prune(this, stamp)
  return name
}

object Quarantine {
  const val MARK = ".corrupt-"
  private const val TMP_SUFFIX = ".tmp"

  /**
   * [prune] plus deletion of every leftover `*.tmp` (a write that was killed between creating the
   * temp file and the atomic rename can leave one holding raw SMS text). Only call it while no
   * write can be in flight, i.e. under the queue lock. Returns how many files were deleted.
   */
  fun pruneAll(store: KeyValueStore, now: Long): Int {
    var deleted = 0
    for (k in store.keys()) {
      if (k.endsWith(TMP_SUFFIX)) {
        store.delete(k)
        deleted++
      }
    }
    return deleted + prune(store, now)
  }
  const val MAX_AGE_MS = 7L * 86_400_000L

  private val NAME = Regex("^(.+)\\.corrupt-(\\d{1,19})$")

  /**
   * Deletes quarantined values (`<key>.corrupt-<ms>`) except the newest of each key, and that one
   * too once it is older than [maxAgeMs] at [now]. A stamp in the future (clock moved back) counts
   * as fresh. Names that do not carry a numeric stamp are left alone. Returns how many were deleted.
   * Called at quarantine time and once per process start ([Storage.housekeeping]).
   */
  fun prune(store: KeyValueStore, now: Long, maxAgeMs: Long = MAX_AGE_MS): Int {
    val byKey = HashMap<String, MutableList<Pair<Long, String>>>()
    for (k in store.keys()) {
      val m = NAME.matchEntire(k) ?: continue
      val stamp = m.groupValues[2].toLongOrNull() ?: continue
      byKey.getOrPut(m.groupValues[1]) { ArrayList() }.add(stamp to k)
    }
    var deleted = 0
    for (list in byKey.values) {
      list.sortByDescending { it.first }
      list.forEachIndexed { i, (stamp, name) ->
        if (i > 0 || now - stamp > maxAgeMs) {
          store.delete(name)
          deleted++
        }
      }
    }
    return deleted
  }
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

  override fun rename(key: String, newKey: String): Boolean {
    val f = File(dir, key)
    if (!f.exists()) return false
    Files.move(f.toPath(), File(dir, newKey).toPath(), StandardCopyOption.REPLACE_EXISTING)
    return true
  }

  override fun keys(): List<String> = dir.listFiles()?.filter { it.isFile }?.map { it.name } ?: emptyList()

  override fun delete(key: String) {
    File(dir, key).delete()
  }
}
