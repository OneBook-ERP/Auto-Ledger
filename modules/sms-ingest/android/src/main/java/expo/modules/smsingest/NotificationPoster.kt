package expo.modules.smsingest

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.app.NotificationCompat

/** Posts the "new transaction" notification. Text comes from the parse only, never the body. */
internal object NotificationPoster {
  const val CHANNEL = "transactions"
  const val DEEP_LINK = "autoledger://inbox"

  fun post(ctx: Context, item: QueuedSms, parse: NativeParse) {
    if (!Perms.notificationsAllowed(ctx)) return
    val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    // Idempotent: re-creating an existing channel only updates its name.
    nm.createNotificationChannel(NotificationChannel(CHANNEL, "Transactions", NotificationManager.IMPORTANCE_DEFAULT))
    val id = NotificationText.notificationId(item.id)
    val open = Intent(Intent.ACTION_VIEW, Uri.parse(DEEP_LINK))
      .setPackage(ctx.packageName)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    val pi = PendingIntent.getActivity(ctx, id, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val icon = android.R.drawable.ic_dialog_info
    val public = NotificationCompat.Builder(ctx, CHANNEL)
      .setSmallIcon(icon)
      .setContentTitle("AutoLedger")
      .setContentText("New bank transaction")
      .build()
    val n = NotificationCompat.Builder(ctx, CHANNEL)
      .setSmallIcon(icon)
      .setContentTitle(NotificationText.title(parse))
      .setContentText("Tap to classify")
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setPublicVersion(public)
      .setContentIntent(pi)
      .setAutoCancel(true)
      .build()
    try {
      nm.notify(id, n)
    } catch (e: SecurityException) {
      // POST_NOTIFICATIONS revoked between the check and here; the queue already holds the SMS.
    }
  }
}
