package expo.modules.smsingest

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import android.util.Log
import java.util.concurrent.Executors

/**
 * SMS_RECEIVED receiver. Runs no JavaScript, so it works with the app process dead. Stores
 * nothing until the app has called setSenderPatterns; drops OTP, ignore-template and non-money
 * SMS before storage (see [MessageClassifier]). The disk work runs off the main thread under
 * goAsync(); the PendingResult is always finished.
 */
class SmsReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
    val msgs = try {
      Telephony.Sms.Intents.getMessagesFromIntent(intent)
    } catch (t: Throwable) {
      null
    } ?: return
    val parts = msgs.filterNotNull().map { SmsPart(it.originatingAddress, it.messageBody, it.timestampMillis) }
    if (parts.isEmpty()) return
    val app = context.applicationContext
    val pending = goAsync()
    EXECUTOR.execute {
      try {
        Storage.housekeeping(app)
        Ingestor.ingest(app, parts)
      } catch (t: Throwable) {
        // Never log the body or sender.
        Log.e(TAG, "ingest failed: ${t.javaClass.simpleName}")
      } finally {
        pending.finish()
      }
    }
  }

  companion object {
    private val EXECUTOR = Executors.newSingleThreadExecutor()
  }
}
