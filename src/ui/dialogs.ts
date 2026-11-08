import { Alert, Linking } from 'react-native';

/** Resolves true only when the confirm button is tapped; Cancel or dismissing the dialog is false. */
export function confirmDialog(o: { title: string; message: string; confirmLabel: string; cancelLabel?: string; destructive?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      o.title,
      o.message,
      [
        { text: o.cancelLabel ?? 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: o.confirmLabel, style: o.destructive ? 'destructive' : 'default', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

/** Opens a URL in the browser; false when it could not be opened. */
export async function openExternal(url: string): Promise<boolean> {
  try {
    await Linking.openURL(url);
    return true;
  } catch {
    return false;
  }
}
