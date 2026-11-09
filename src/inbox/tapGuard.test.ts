import { createTapGuard } from './tapGuard';

it('runs the first tap and drops repeats inside the window', () => {
  let t = 1000;
  const guard = createTapGuard(() => t, 800);
  const fn = jest.fn();
  expect(guard(fn)).toBe(true);
  t += 100;
  expect(guard(fn)).toBe(false);
  t += 699;
  expect(guard(fn)).toBe(false);
  t += 1;
  expect(guard(fn)).toBe(true);
  expect(fn).toHaveBeenCalledTimes(2);
});
