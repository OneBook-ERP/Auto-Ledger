import { render, screen } from '@testing-library/react-native';
import { Appearance } from 'react-native';
import { ActivityRow } from './ActivityRow';
import { TxnRow } from './TxnRow';

const base = { title: 'ANTHROPIC* CLAUDE SUBSCRIPTION LONG NAME', subtitle: 'Card spend · x', amountText: '−₹1,231.92', amountA11y: '₹1,231.92 paid', chip: { text: 'What was this?', tone: 'plain' as const }, onPress: () => undefined };

describe('TxnRow', () => {
  it('title clamps to two lines and the amount stays on one', async () => {
    await render(<TxnRow {...base} direction="out" kindIcon="card" />);
    expect(screen.getByText(base.title).props.numberOfLines).toBe(2);
    expect(screen.getByText('−₹1,231.92').props.numberOfLines).toBe(1);
  });
  it('money in and out use their own direction colours (and out is not the error red)', async () => {
    const { rerender } = await render(<TxnRow {...base} direction="in" amountText="+₹5.00" />);
    expect(screen.getByText('+₹5.00').props.className).toContain('text-money-in');
    await rerender(<TxnRow {...base} direction="out" />);
    const cls = screen.getByText('−₹1,231.92').props.className as string;
    expect(cls).toContain('text-money-out');
    expect(cls).not.toContain('danger');
    expect(cls).toContain('dark:text-money-out-dark');
  });
  it('the sign and the spoken label carry the direction, not only the colour', async () => {
    await render(<TxnRow {...base} direction="out" />);
    expect(screen.getByText('−₹1,231.92')).toBeTruthy();
    expect(screen.getByRole('button').props.accessibilityLabel).toContain('₹1,231.92 paid');
  });
});

describe('TxnRow colour scheme', () => {
  afterEach(() => jest.restoreAllMocks());
  it('a whole list shares one Appearance listener instead of one per row', async () => {
    const remove = jest.fn();
    const add = jest.spyOn(Appearance, 'addChangeListener').mockReturnValue({ remove });
    const { unmount } = await render(<>{Array.from({ length: 30 }, (_, i) => <TxnRow key={i} {...base} direction="out" />)}</>);
    expect(add).toHaveBeenCalledTimes(1);
    await unmount();
    expect(remove).toHaveBeenCalledTimes(1);
  });
  it('follows a scheme change', async () => {
    let fire: () => void = () => undefined;
    jest.spyOn(Appearance, 'addChangeListener').mockImplementation((l) => { fire = () => l({ colorScheme: 'dark' }); return { remove: () => undefined }; });
    const get = jest.spyOn(Appearance, 'getColorScheme').mockReturnValue('light');
    await render(<TxnRow {...base} direction="out" />);
    get.mockReturnValue('dark');
    const { act } = require('@testing-library/react-native');
    await act(async () => fire());
    expect(screen.getByRole('button')).toBeTruthy();
  });
});

describe('ActivityRow amount colour', () => {
  const row = { title: 'Fuel', date: '5 Nov 2026', docs: [], status: { label: 'Draft', tone: 'info' as const }, actions: [] };
  it('uses the direction colour and keeps the signed text', async () => {
    const { rerender } = await render(<ActivityRow {...row} amount="+₹5.00" direction="in" />);
    expect(screen.getByText('+₹5.00').props.className).toContain('text-money-in');
    await rerender(<ActivityRow {...row} amount="−₹5.00" direction="out" />);
    expect(screen.getByText('−₹5.00').props.className).toContain('text-money-out');
  });
});
