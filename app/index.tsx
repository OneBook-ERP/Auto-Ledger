import { View } from 'react-native';
import { ListRow } from '../src/ui';

export default function Index() {
  return (
    <View className="flex-1 bg-white pt-16">
      <ListRow title="AutoLedger" subtitle="Scaffold ready" right="₹0.00" />
    </View>
  );
}
