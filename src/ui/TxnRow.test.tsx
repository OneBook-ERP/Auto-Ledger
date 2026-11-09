import { render, screen } from '@testing-library/react-native';
import { TxnRow } from './TxnRow';

const base = { title: 'ANTHROPIC* CLAUDE SUBSCRIPTION LONG NAME', subtitle: 'Card spend · x', amountText: '−₹1,231.92', amountA11y: '₹1,231.92 paid', chip: { text: 'What was this?', tone: 'plain' as const }, onPress: () => undefined };

describe('TxnRow', () => {
  it('title clamps to two lines and the amount stays on one', async () => {
    await render(<TxnRow {...base} direction="out" kindIcon="card" />);
    expect(screen.getByText(base.title).props.numberOfLines).toBe(2);
    expect(screen.getByText('−₹1,231.92').props.numberOfLines).toBe(1);
  });
  it('money in is green, money out is plain ink (not red)', async () => {
    const { rerender } = await render(<TxnRow {...base} direction="in" amountText="+₹5.00" />);
    expect(screen.getByText('+₹5.00').props.className).toContain('text-ok');
    await rerender(<TxnRow {...base} direction="out" />);
    const cls = screen.getByText('−₹1,231.92').props.className as string;
    expect(cls).toContain('text-ink');
    expect(cls).not.toContain('danger');
  });
});
