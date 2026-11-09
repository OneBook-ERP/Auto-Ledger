import { render } from '@testing-library/react-native';
import { Icon, ICONS, type IconName } from './Icon';

describe('Icon', () => {
  it('renders every named icon without throwing', async () => {
    for (const name of Object.keys(ICONS) as IconName[]) {
      const r = await render(<Icon name={name} color="#000" />);
      expect(r.toJSON()).toBeTruthy();
      await r.unmount();
    }
  });
  it('passes colour and size to the drawing and hides it from screen readers', async () => {
    const r = await render(<Icon name="home" color="#123456" size={30} />);
    const json = r.toJSON() as { props: Record<string, unknown> };
    expect(json.props).toMatchObject({ stroke: '#123456', width: 30, height: 30, accessibilityElementsHidden: true });
  });
});
