import { createNameMap, isOtp, redact, redactMessages } from './redact-sms';

describe('redact', () => {
  it('leaves no digit run of 9 or more', () => {
    const names = createNameMap();
    const bodies = [
      'Your a/c ending XXXXXXXX234 is debited by Rs. 10000.00 on 07-Nov-26 and a/c ending XXXXXXXXX567 credited (IMPS Ref no 123456789012 ). Team IDFC FIRST Bank',
      'Your A/C XXXXX012345 is debited by INR 1,000.00 on 07/10/26 11:10. New Bal :INR 2,000.00. Call us on 180010888 for dispute.',
      'Dear Sir/Ma\'am, Used Car Loan a/c 12345678901 as Address Proof. Call 9876500000.',
    ];
    for (const b of bodies) expect(redact(b, names)).not.toMatch(/\d{9,}/);
  });

  it('keeps amounts, grouping styles, dates, times and balances unchanged', () => {
    const names = createNameMap();
    for (const s of [
      'INR 1,3,000.00 on 04/11/26 12:35. New Bal :INR 38,222.72.',
      'Rs. 115,000.00 on 25-08-2026. New bal: Rs. 590,258.76.',
      'Rs. 300000.00 on 01-Nov-26',
      'INR 78948.53 spent on your card at 08:37 PM',
      'Rs 2000000 limit',
    ]) {
      expect(redact(s, names)).toBe(s);
    }
  });

  it('keeps the last 4 digits of masked accounts and cards', () => {
    const names = createNameMap();
    expect(redact('A/C XXXXX012345 and XX1111 and XXXXXXX1234', names)).toBe(
      'A/C XXXXX992345 and XX1111 and XXXXXXX1234',
    );
  });

  it('keeps the UTR shape and maps the same UTR to the same fake', () => {
    const names = createNameMap();
    const a = redact('Info: NEFT/ IDFB0000M1111111/X.\nNew', names);
    const b = redact('NEFT UTR IDFB0000M1111111.', names);
    const utrA = a.match(/IDFB\d{4}M\d{7}/)![0];
    const utrB = b.match(/IDFB\d{4}M\d{7}/)![0];
    expect(utrA).toBe(utrB);
    expect(utrA).not.toBe('IDFB0000M1111111');
    // runs longer than 8 digits are shortened to 8 so that no 9+ digit run can survive
    expect(redact('NEFT/IDFBH12345678901', createNameMap())).toMatch(/^NEFT\/IDFBH\d{8}$/);
  });

  it('maps names after Info: NEFT/ref/ and beneficiary to stable placeholders', () => {
    const names = createNameMap();
    const credit = redact(
      'credited with Rs. 3,000.00 on 05-11-2026. Info: NEFT/SBIN123456789012/ACME TEST TRADERS.\nNew bal: Rs. 9,000.00.',
      names,
    );
    expect(credit).toContain('Info: NEFT/SBIN');
    expect(credit).toMatch(/\/COMPANY_1\.\nNew bal/);
    const debit = redact('Info: NEFT/ IDFB0000M1111111/ASHA EXAMPLE.\nNew bal', names);
    expect(debit).toMatch(/\/PERSON_1\.\nNew bal/);
    const conf1 = redact('Your beneficiary ASHA EXAMPLE has received Rs. 2,100.00 transferred via NEFT UTR IDFB1.', names);
    const conf2 = redact('Your beneficiary Other P has received Rs. 5.00 transferred via NEFT UTR IDFB1.', names);
    const conf3 = redact('Your beneficiary ASHA EXAMPLE has received Rs. 9.00 transferred via NEFT UTR IDFB1.', names);
    expect(conf1).toContain('beneficiary PERSON_1 has received');
    expect(conf2).toContain('beneficiary PERSON_2 has received');
    expect(conf3).toContain('beneficiary PERSON_1 has received');
  });

  it('leaves the nameless beneficiary variant alone', () => {
    const s = 'Dear Customer, Your beneficiary has received Rs 8,000.00 transferred via NEFT IDFB.';
    expect(redact(s, createNameMap())).toBe(s);
  });

  it('replaces personal Dear names but keeps Dear Customer/Cardmember', () => {
    const names = createNameMap();
    expect(redact('Dear Asha Example, your card', names)).toBe('Dear PERSON_1, your card');
    expect(redact('Dear Cardmember, you', names)).toBe('Dear Cardmember, you');
    expect(redact('Dear Customer, Your', names)).toBe('Dear Customer, Your');
  });

  it('keeps known merchants and replaces unknown card merchants', () => {
    const names = createNameMap();
    const s1 = 'Transaction Successful! INR 100.00 spent on your IDFC FIRST Bank Credit Card ending XX8129 at TEST SHOP on 08 NOV 2026 at 10:09 AM Avbl Limit: INR 5000.00';
    expect(redact(s1, names)).toContain(' at COMPANY_1 on 08 NOV 2026 at 10:09 AM');
    const s2 = 'spent on your card ending XX3455 at ANTHROPIC* CLAUDE SUB on 08 OCT 2026';
    expect(redact(s2, names)).toBe(s2);
    const s3 = 'spent on your card ending XX3455 at FACEBOOK SI on 06 NOV 2026';
    expect(redact(s3, names)).toBe(s3);
    const s4 = 'INR 1.00 for Google Ads paid from your Card';
    expect(redact(s4, names)).toBe(s4);
  });

  it('randomises shortlink and SiHub/Mandate tokens, keeping shape and consistency', () => {
    const names = createNameMap();
    const s = 'Manage SI: https://idfcfr.in/IDFCFB/4cJPWW using the SiHub ID: YY9HGpJisE';
    const out = redact(s, names);
    expect(out).toMatch(/^Manage SI: https:\/\/idfcfr\.in\/IDFCFB\/[A-Za-z0-9]{6} using the SiHub ID: [A-Za-z0-9]{10}$/);
    expect(out).not.toContain('4cJPWW');
    expect(out).not.toContain('YY9HGpJisE');
    expect(redact(s, names)).toBe(out);
  });

  it('rewrites the 9-digit toll-free number so that no 9+ digit run remains', () => {
    expect(redact('call 180010888 for dispute SMS CCBLOCK 3455 to 5676732', createNameMap())).toBe(
      'call 1800 10 888 for dispute SMS CCBLOCK 3455 to 5676732',
    );
  });
});

describe('isOtp / redactMessages', () => {
  it('detects OTP bodies', () => {
    expect(isOtp('123456 is your OTP for login. Do not share.')).toBe(true);
    expect(isOtp('INR 1.00 spent on your card')).toBe(false);
  });

  it('drops OTPs and redacts the rest', () => {
    const out = redactMessages([
      ['VM-IDFCFB-S', 1, 'Your OTP is 111111. Do not share.'],
      ['VM-IDFCFB-S', 2, 'Your beneficiary ASHA EXAMPLE has received Rs. 1.00 transferred via NEFT UTR IDFB0000M2222222.'],
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].receivedAt).toBe(2);
    expect(out[0].body).toContain('PERSON_1');
  });
});
