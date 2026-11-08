package expo.modules.smsingest

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class SmsIngestModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("No React context")

  private fun wanted(): Array<String> =
    if (Build.VERSION.SDK_INT >= 33)
      arrayOf(Manifest.permission.RECEIVE_SMS, Manifest.permission.POST_NOTIFICATIONS)
    else arrayOf(Manifest.permission.RECEIVE_SMS)

  override fun definition() = ModuleDefinition {
    Name("SmsIngest")

    // Spike: fires the system dialogs and returns; call hasPermission() afterwards.
    AsyncFunction("requestPermissions") {
      val activity = appContext.currentActivity ?: throw IllegalStateException("No activity")
      ActivityCompat.requestPermissions(activity, wanted(), 4711)
      true
    }

    Function("hasPermission") {
      ContextCompat.checkSelfPermission(context, Manifest.permission.RECEIVE_SMS) ==
        PackageManager.PERMISSION_GRANTED
    }

    AsyncFunction("peekQueue") {
      context.getSharedPreferences(SmsReceiver.PREFS, Context.MODE_PRIVATE)
        .getString(SmsReceiver.KEY, "[]") ?: "[]"
    }
  }
}
