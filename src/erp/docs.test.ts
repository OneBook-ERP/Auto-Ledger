import { ErpClient, ErpValidationError } from './client';
import {
  NotDraftError,
  createDraft,
  createParty,
  deleteDraft,
  findDraftByUtr,
  findDraftsByUtr,
  getDraftSummary,
  getBankBalance,
  getDocStatuses,
  getReceivablesPayables,
  getRequiredFields,
  listBankAccounts,
  listBookedEntries,
  BOOKED_PAGE_SIZE,
  listCompanies,
  listLedgerAccounts,
  listModesOfPayment,
  listOpenInvoices,
  listOpenSalesOrders,
  searchParties,
  toMinor,
} from './docs';

type Reply = { status?: number; body?: unknown };
const BASE = 'https://x.example';

function setup(...replies: Reply[]) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  let i = 0;
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method as string, body: init.body ? JSON.parse(init.body as string) : undefined });
    const r = replies[Math.min(i++, replies.length - 1)];
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { c: new ErpClient({ siteUrl: BASE, apiKey: 'k', apiSecret: 's', fetchImpl: impl }), calls };
}
const q = (o: Record<string, unknown>) =>
  Object.entries(o).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(typeof v === 'string' ? v : JSON.stringify(v))}`).join('&');

describe('toMinor', () => {
  it.each([
    [1131.5, 113150],
    [19999.99, 1999999],
    [0.07, 7],
    [0.1 + 0.2, 30],
    [1.005, 101],
    [-2484917.58, -248491758],
    [5.8e-11, 0],
    ['1234.56', 123456],
    [0, 0],
    [null, 0],
    [undefined, 0],
  ])('%p -> %p', (x, want) => {
    expect(toMinor(x as number)).toBe(want);
  });
});

describe('toMinor invalid input', () => {
  it.each([[NaN], ['1,234.56'], ['abc'], [Infinity]])('throws for %p', (x) => {
    expect(() => toMinor(x as number)).toThrow();
  });
});

describe('simple lists', () => {
  it('listCompanies', async () => {
    const { c, calls } = setup({ body: { data: [{ name: 'ZP Co', default_currency: 'INR' }] } });
    expect(await listCompanies(c)).toEqual([{ name: 'ZP Co', currency: 'INR' }]);
    expect(calls[0].url).toBe(`${BASE}/api/resource/Company?${q({ fields: ['name', 'default_currency'], limit_page_length: 0 })}`);
  });

  it('listBankAccounts maps fields', async () => {
    const { c, calls } = setup({
      body: { data: [{ name: 'IDFC - Zen', account: 'IDFC First - ZP', bank_account_no: '123', is_company_account: 1, bank: 'IDFC First Bank' }, { name: 'B', account: 'X - ZP', bank_account_no: null, is_company_account: 0, bank: null }] },
    });
    expect(await listBankAccounts(c, 'ZP Co')).toEqual([
      { name: 'IDFC - Zen', glAccount: 'IDFC First - ZP', bankAccountNo: '123', isCompanyAccount: true, bank: 'IDFC First Bank' },
      { name: 'B', glAccount: 'X - ZP', bankAccountNo: null, isCompanyAccount: false, bank: null },
    ]);
    expect(calls[0].url).toBe(
      `${BASE}/api/resource/Bank%20Account?${q({ fields: ['name', 'account', 'bank_account_no', 'is_company_account', 'bank'], filters: [['company', '=', 'ZP Co']], limit_page_length: 0 })}`,
    );
  });

  it('listLedgerAccounts: non-group, with root type', async () => {
    const { c, calls } = setup({ body: { data: [{ name: 'Rent - ZP', account_type: null }] } });
    expect(await listLedgerAccounts(c, 'ZP Co', { rootType: 'Expense' })).toEqual([{ name: 'Rent - ZP', accountType: null }]);
    expect(calls[0].url).toBe(
      `${BASE}/api/resource/Account?${q({ fields: ['name', 'account_type'], filters: [['company', '=', 'ZP Co'], ['is_group', '=', 0], ['root_type', '=', 'Expense']], limit_page_length: 0 })}`,
    );
  });

  it('listLedgerAccounts without root type omits that filter', async () => {
    const { c, calls } = setup({ body: { data: [] } });
    await listLedgerAccounts(c, 'ZP Co', {});
    expect(calls[0].url).toContain(encodeURIComponent(JSON.stringify([['company', '=', 'ZP Co'], ['is_group', '=', 0]])));
  });

  it('listModesOfPayment: enabled modes with their type, explicit page length', async () => {
    const { c, calls } = setup({ body: { data: [{ name: 'Bank Draft', type: 'Bank' }, { name: 'Cash', type: 'Cash' }, { name: 'Other', type: null }] } });
    expect(await listModesOfPayment(c)).toEqual([
      { name: 'Bank Draft', type: 'Bank' },
      { name: 'Cash', type: 'Cash' },
      { name: 'Other', type: null },
    ]);
    expect(calls[0].url).toBe(
      `${BASE}/api/resource/Mode%20of%20Payment?${q({ fields: ['name', 'type'], filters: [['enabled', '=', 1]], order_by: 'name asc', limit_page_length: 0 })}`,
    );
  });

  it('searchParties queries name and display name', async () => {
    const { c, calls } = setup({ body: { data: [{ name: 'CUST-1', customer_name: 'Acme Traders' }, { name: 'Acme #1/2', customer_name: null }] } });
    expect(await searchParties(c, 'Customer', 'ac')).toEqual([
      { doctype: 'Customer', name: 'CUST-1', displayName: 'Acme Traders' },
      { doctype: 'Customer', name: 'Acme #1/2', displayName: 'Acme #1/2' },
    ]);
    expect(calls[0].url).toBe(
      `${BASE}/api/resource/Customer?${q({ fields: ['name', 'customer_name'], or_filters: [['name', 'like', '%ac%'], ['customer_name', 'like', '%ac%']], limit_page_length: 20 })}`,
    );
  });

  it('searchParties exact uses an equality filter on the display-name field', async () => {
    const { c, calls } = setup({ body: { data: [{ name: 'HR-EMP-00007', employee_name: 'Ravi 50% Kumar_' }] } });
    expect(await searchParties(c, 'Employee', 'Ravi 50% Kumar_', true)).toEqual([{ doctype: 'Employee', name: 'HR-EMP-00007', displayName: 'Ravi 50% Kumar_' }]);
    expect(calls[0].url).toBe(
      `${BASE}/api/resource/Employee?${q({ fields: ['name', 'employee_name'], filters: [['employee_name', '=', 'Ravi 50% Kumar_']], order_by: 'creation asc', limit_page_length: 20 })}`,
    );
    expect(decodeURIComponent(calls[0].url)).not.toMatch(/like/);
  });

  it('searchParties uses supplier_name / employee_name', async () => {
    const s = setup({ body: { data: [] } });
    await searchParties(s.c, 'Supplier', 'x');
    expect(s.calls[0].url).toBe(
      `${BASE}/api/resource/Supplier?${q({ fields: ['name', 'supplier_name'], or_filters: [['name', 'like', '%x%'], ['supplier_name', 'like', '%x%']], limit_page_length: 20 })}`,
    );
    const e = setup({ body: { data: [{ name: 'HR-EMP-00007', employee_name: 'Ravi Kumar' }] } });
    expect(await searchParties(e.c, 'Employee', 'Ravi Kumar')).toEqual([{ doctype: 'Employee', name: 'HR-EMP-00007', displayName: 'Ravi Kumar' }]);
    expect(e.calls[0].url).toBe(
      `${BASE}/api/resource/Employee?${q({ fields: ['name', 'employee_name'], or_filters: [['name', 'like', '%Ravi Kumar%'], ['employee_name', 'like', '%Ravi Kumar%']], limit_page_length: 20 })}`,
    );
  });
});

describe('createParty', () => {
  it('posts caller fields and returns the server name', async () => {
    const { c, calls } = setup({ body: { data: { name: 'Acme Ltd', docstatus: 0 } } });
    const r = await createParty(c, 'Customer', { customer_name: 'Acme Ltd', customer_type: 'Company' });
    expect(r).toEqual({ doctype: 'Customer', name: 'Acme Ltd' });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe(`${BASE}/api/resource/Customer`);
    expect(calls[0].body).toEqual({ customer_name: 'Acme Ltd', customer_type: 'Company' });
  });

  it.each([
    ['Customer', {}, 'customer_name'],
    ['Customer', { customer_name: '   ' }, 'customer_name'],
    ['Customer', { customer_name: 5 }, 'customer_name'],
    ['Supplier', { supplier_name: '' }, 'supplier_name'],
  ] as const)('validates client-side before any request: %s %j', async (dt, fields, missing) => {
    const { c, calls } = setup({ body: {} });
    const err = await createParty(c, dt, fields as Record<string, unknown>).catch((e) => e);
    expect(err).toBeInstanceOf(ErpValidationError);
    expect(err.missingFields).toEqual([missing]);
    expect(calls).toHaveLength(0);
  });

  it('employee needs first_name (or employee_name)', async () => {
    const { c, calls } = setup({ body: {} });
    const err = await createParty(c, 'Employee', { gender: 'Male' }).catch((e) => e);
    expect(err).toBeInstanceOf(ErpValidationError);
    expect(err.missingFields).toEqual(['first_name']);
    expect(calls).toHaveLength(0);
  });

  it('maps a server MandatoryError to missingFields', async () => {
    const { c } = setup({
      status: 417,
      body: {
        exc_type: 'MandatoryError',
        exception: 'frappe.exceptions.MandatoryError: [Employee, HR-EMP-00015]: gender, date_of_birth',
        _server_messages: JSON.stringify([
          JSON.stringify({ message: 'Error: Value missing for Employee: Gender', title: 'Message' }),
          JSON.stringify({ message: 'Error: Value missing for Employee: Date of Birth', title: 'Message' }),
        ]),
      },
    });
    const err = await createParty(c, 'Employee', { first_name: 'Asha' }).catch((e) => e);
    expect(err).toBeInstanceOf(ErpValidationError);
    expect(err.missingFields).toEqual(['Gender', 'Date of Birth']);
  });
});

describe('getRequiredFields', () => {
  it('returns reqd fields without a default from the main doc', async () => {
    const { c, calls } = setup({
      body: {
        docs: [
          {
            name: 'Customer',
            fields: [
              { fieldname: 'customer_name', label: 'Full Name', fieldtype: 'Data', reqd: 1, default: null },
              { fieldname: 'customer_type', label: 'Type', fieldtype: 'Select', reqd: 1, default: 'Company' },
              { fieldname: 'gstin', label: 'GSTIN', fieldtype: 'Autocomplete', reqd: 0 },
              { fieldname: 'territory', label: 'Territory', fieldtype: 'Link', reqd: 1 },
            ],
          },
          { name: 'Child', fields: [{ fieldname: 'zzz', label: 'Z', fieldtype: 'Data', reqd: 1 }] },
        ],
      },
    });
    expect(await getRequiredFields(c, 'Customer')).toEqual([
      { fieldname: 'customer_name', label: 'Full Name', fieldtype: 'Data' },
      { fieldname: 'territory', label: 'Territory', fieldtype: 'Link' },
    ]);
    expect(calls[0].url).toBe(`${BASE}/api/method/frappe.desk.form.load.getdoctype?doctype=Customer&with_parent=1`);
    expect(calls[0].method).toBe('GET');
  });
});

describe('listOpenInvoices', () => {
  it('Customer -> Sales Invoice, minor units without drift', async () => {
    const { c, calls } = setup({
      body: { data: [{ name: 'ZP-SI-26-00012', outstanding_amount: 1131.5, due_date: '2026-11-30' }, { name: 'SI-2', outstanding_amount: 19999.99, due_date: '2026-12-01' }, { name: 'SI-3', outstanding_amount: 0.07, due_date: '2026-12-02' }] },
    });
    expect(await listOpenInvoices(c, 'Customer', 'Acme #1')).toEqual([
      { doctype: 'Sales Invoice', name: 'ZP-SI-26-00012', outstandingMinor: 113150, dueDate: '2026-11-30' },
      { doctype: 'Sales Invoice', name: 'SI-2', outstandingMinor: 1999999, dueDate: '2026-12-01' },
      { doctype: 'Sales Invoice', name: 'SI-3', outstandingMinor: 7, dueDate: '2026-12-02' },
    ]);
    expect(calls[0].url).toBe(
      `${BASE}/api/resource/Sales%20Invoice?${q({ fields: ['name', 'outstanding_amount', 'due_date'], filters: [['docstatus', '=', 1], ['outstanding_amount', '>', 0], ['customer', '=', 'Acme #1']], order_by: 'due_date asc', limit_page_length: 0 })}`,
    );
  });

  it('Supplier -> Purchase Invoice', async () => {
    const { c, calls } = setup({ body: { data: [{ name: 'PINV-1', outstanding_amount: 10, due_date: null }] } });
    const r = await listOpenInvoices(c, 'Supplier', 'Bharti');
    expect(r).toEqual([{ doctype: 'Purchase Invoice', name: 'PINV-1', outstandingMinor: 1000, dueDate: '' }]);
    expect(calls[0].url).toContain('/api/resource/Purchase%20Invoice?');
    expect(calls[0].url).toContain(encodeURIComponent('["supplier","=","Bharti"]'));
  });
});

describe('listOpenSalesOrders', () => {
  const row = (o: Record<string, unknown>) => ({
    docstatus: 1, status: 'To Deliver and Bill', transaction_date: '2026-10-01', delivery_date: '2026-11-30', advance_paid: 0, ...o,
  });

  it('queries open submitted orders of the customer and maps money in minor units', async () => {
    const { c, calls } = setup({
      body: { data: [row({ name: 'SAL-ORD-2026-2027-00004', grand_total: 25000.1, advance_paid: 1131.5, delivery_date: null })] },
    });
    expect(await listOpenSalesOrders(c, 'Acme #1')).toEqual([
      { name: 'SAL-ORD-2026-2027-00004', totalMinor: 2500010, advanceMinor: 113150, remainingMinor: 2386860, deliveryDate: null, orderDate: '2026-10-01' },
    ]);
    expect(calls[0].url).toBe(
      `${BASE}/api/resource/Sales%20Order?${q({
        fields: [
          'name', 'grand_total', 'rounded_total', 'base_grand_total', 'base_rounded_total', 'advance_paid', 'delivery_date', 'status', 'docstatus', 'transaction_date',
        ],
        filters: [['customer', '=', 'Acme #1'], ['docstatus', '=', 1], ['status', 'in', ['To Deliver and Bill', 'To Bill', 'To Deliver']]],
        order_by: 'transaction_date asc, creation asc',
        limit_page_length: 0,
      })}`,
    );
  });

  it('keeps only docstatus 1 orders that are not Closed, Cancelled or Completed', async () => {
    const { c } = setup({
      body: {
        data: [
          row({ name: 'SO-OK1', grand_total: 100, status: 'To Bill' }),
          row({ name: 'SO-DRAFT', grand_total: 100, docstatus: 0, status: 'Draft' }),
          row({ name: 'SO-CLOSED', grand_total: 100, status: 'Closed' }),
          row({ name: 'SO-CANC', grand_total: 100, docstatus: 2, status: 'Cancelled' }),
          row({ name: 'SO-DONE', grand_total: 100, status: 'Completed' }),
          row({ name: 'SO-OK2', grand_total: 100, status: 'To Deliver' }),
        ],
      },
    });
    expect((await listOpenSalesOrders(c, 'Acme')).map((o) => o.name)).toEqual(['SO-OK1', 'SO-OK2']);
  });

  it('remaining = total - advance without float drift; fully paid orders are omitted', async () => {
    const { c } = setup({
      body: {
        data: [
          row({ name: 'SO-1', grand_total: 0.3, advance_paid: 0.1 }),
          row({ name: 'SO-PAID', grand_total: 500, advance_paid: 500 }),
          row({ name: 'SO-OVER', grand_total: 500, advance_paid: 600 }),
          row({ name: 'SO-2', grand_total: '19999.99', advance_paid: null }),
        ],
      },
    });
    expect(await listOpenSalesOrders(c, 'Acme')).toEqual([
      { name: 'SO-1', totalMinor: 30, advanceMinor: 10, remainingMinor: 20, deliveryDate: '2026-11-30', orderDate: '2026-10-01' },
      { name: 'SO-2', totalMinor: 1999999, advanceMinor: 0, remainingMinor: 1999999, deliveryDate: '2026-11-30', orderDate: '2026-10-01' },
    ]);
  });

  it('total matches ERPNext outstanding: base_rounded_total when set, else base_grand_total', async () => {
    const { c } = setup({
      body: {
        data: [
          row({ name: 'SO-ROUND', grand_total: 1000.4, rounded_total: 1000, base_grand_total: 1000.4, base_rounded_total: 1000, advance_paid: 200.1 }),
          row({ name: 'SO-NOROUND', grand_total: 1000.4, rounded_total: 0, base_grand_total: 1000.4, base_rounded_total: 0, advance_paid: 0 }),
          row({ name: 'SO-USD', grand_total: 100, rounded_total: 100, base_grand_total: 8500.55, base_rounded_total: '8501', advance_paid: 0 }),
        ],
      },
    });
    expect(await listOpenSalesOrders(c, 'Acme')).toEqual([
      { name: 'SO-ROUND', totalMinor: 100000, advanceMinor: 20010, remainingMinor: 79990, deliveryDate: '2026-11-30', orderDate: '2026-10-01' },
      { name: 'SO-NOROUND', totalMinor: 100040, advanceMinor: 0, remainingMinor: 100040, deliveryDate: '2026-11-30', orderDate: '2026-10-01' },
      { name: 'SO-USD', totalMinor: 850100, advanceMinor: 0, remainingMinor: 850100, deliveryDate: '2026-11-30', orderDate: '2026-10-01' },
    ]);
  });

  it('an order with no date sorts first and has a null orderDate', async () => {
    const { c } = setup({ body: { data: [row({ name: 'SO-A', grand_total: 1 }), row({ name: 'SO-B', grand_total: 1, transaction_date: null })] } });
    const r = await listOpenSalesOrders(c, 'Acme');
    expect(r.map((o) => [o.name, o.orderDate])).toEqual([['SO-B', null], ['SO-A', '2026-10-01']]);
  });

  it('sorted oldest first (by order date, stable)', async () => {
    const { c } = setup({
      body: {
        data: [
          row({ name: 'SO-NEW', grand_total: 1, transaction_date: '2026-11-05' }),
          row({ name: 'SO-OLD', grand_total: 1, transaction_date: '2026-09-01' }),
          row({ name: 'SO-MID-A', grand_total: 1, transaction_date: '2026-10-01' }),
          row({ name: 'SO-MID-B', grand_total: 1, transaction_date: '2026-10-01' }),
        ],
      },
    });
    expect((await listOpenSalesOrders(c, 'Acme')).map((o) => o.name)).toEqual(['SO-OLD', 'SO-MID-A', 'SO-MID-B', 'SO-NEW']);
  });

  it('rejects a reply without a data array', async () => {
    const { c } = setup({ body: { message: [] } });
    await expect(listOpenSalesOrders(c, 'Acme')).rejects.toThrow();
  });
});

describe('createDraft', () => {
  it('posts to the encoded doctype path and returns the name (no submit)', async () => {
    const { c, calls } = setup({ body: { data: { name: 'ACC-PAY-2026-00039', docstatus: 0 } } });
    const body = { company: 'ZP', reference_no: 'U1' };
    expect(await createDraft(c, 'Payment Entry', body)).toEqual({ name: 'ACC-PAY-2026-00039' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/api/resource/Payment%20Entry`);
    expect(calls[0].body).toEqual({ ...body, docstatus: 0 });
  });

  it('forces docstatus 0 even if the caller passes 1', async () => {
    const { c, calls } = setup({ body: { data: { name: 'X' } } });
    await createDraft(c, 'Journal Entry', { company: 'ZP', docstatus: 1 });
    expect((calls[0].body as { docstatus: number }).docstatus).toBe(0);
  });
});

describe('findDraftByUtr', () => {
  it('queries Payment Entry by reference_no, returns first hit (a thin wrapper of findDraftsByUtr)', async () => {
    const { c, calls } = setup({ body: { data: [{ name: 'ACC-PAY-1', docstatus: 0 }] } }, { body: { data: [] } });
    expect(await findDraftByUtr(c, 'U/1 #')).toEqual({ doctype: 'Payment Entry', name: 'ACC-PAY-1', docstatus: 0 });
    expect(calls[0].url).toBe(
      `${BASE}/api/resource/Payment%20Entry?${q({ fields: ['name', 'docstatus'], filters: [['reference_no', '=', 'U/1 #'], ['docstatus', '!=', 2]], order_by: 'creation asc', limit_page_length: 20 })}`,
    );
  });

  it('falls through to Journal Entry by cheque_no', async () => {
    const { c, calls } = setup({ body: { data: [] } }, { body: { data: [{ name: 'ACC-JV-9', docstatus: 1 }] } });
    expect(await findDraftByUtr(c, 'U2')).toEqual({ doctype: 'Journal Entry', name: 'ACC-JV-9', docstatus: 1 });
    expect(calls[1].url).toBe(
      `${BASE}/api/resource/Journal%20Entry?${q({ fields: ['name', 'docstatus'], filters: [['cheque_no', '=', 'U2'], ['docstatus', '!=', 2]], order_by: 'creation asc', limit_page_length: 20 })}`,
    );
  });

  it('sends quotes and brackets inside the JSON filter, encoded', async () => {
    const utr = 'A"B]["C\\';
    const { c, calls } = setup({ body: { data: [{ name: 'P1', docstatus: 1 }] } });
    expect(await findDraftByUtr(c, utr)).toEqual({ doctype: 'Payment Entry', name: 'P1', docstatus: 1 });
    expect(calls[0].url).toContain(`filters=${encodeURIComponent(JSON.stringify([['reference_no', '=', utr], ['docstatus', '!=', 2]]))}`);
  });

  it('only-cancelled documents (server returns none) give null; the live draft is the hit', async () => {
    const { c } = setup({ body: { data: [] } }, { body: { data: [] } });
    expect(await findDraftByUtr(c, 'U9')).toBeNull();
    const live = setup({ body: { data: [{ name: 'LIVE', docstatus: 0 }] } });
    expect(await findDraftByUtr(live.c, 'U9')).toEqual({ doctype: 'Payment Entry', name: 'LIVE', docstatus: 0 });
  });

  it('null when neither has it', async () => {
    const { c } = setup({ body: { data: [] } });
    expect(await findDraftByUtr(c, 'U3')).toBeNull();
  });
});

describe('findDraftsByUtr (KL1)', () => {
  it('returns every hit, Payment Entries first then Journal Entries, in server (creation asc) order', async () => {
    const { c, calls } = setup(
      { body: { data: [{ name: 'PE-1', docstatus: 0 }, { name: 'PE-2', docstatus: 1 }] } },
      { body: { data: [{ name: 'JV-1', docstatus: 0 }] } },
    );
    expect(await findDraftsByUtr(c, 'U1')).toEqual([
      { doctype: 'Payment Entry', name: 'PE-1', docstatus: 0 },
      { doctype: 'Payment Entry', name: 'PE-2', docstatus: 1 },
      { doctype: 'Journal Entry', name: 'JV-1', docstatus: 0 },
    ]);
    expect(calls.map((x) => x.url)).toEqual([
      `${BASE}/api/resource/Payment%20Entry?${q({ fields: ['name', 'docstatus'], filters: [['reference_no', '=', 'U1'], ['docstatus', '!=', 2]], order_by: 'creation asc', limit_page_length: 20 })}`,
      `${BASE}/api/resource/Journal%20Entry?${q({ fields: ['name', 'docstatus'], filters: [['cheque_no', '=', 'U1'], ['docstatus', '!=', 2]], order_by: 'creation asc', limit_page_length: 20 })}`,
    ]);
  });

  it('[] when neither has it', async () => {
    const { c } = setup({ body: { data: [] } });
    expect(await findDraftsByUtr(c, 'U3')).toEqual([]);
  });

  it('a malformed reply is an error, not "no hits"', async () => {
    const { c } = setup({ body: { nope: 1 } });
    await expect(findDraftsByUtr(c, 'U3')).rejects.toThrow();
  });
});

describe('getDraftSummary', () => {
  it('reads one Payment Entry and maps the compared fields (amounts in minor units)', async () => {
    const { c, calls } = setup({ body: { data: { name: 'ACC PAY/1', docstatus: 0, company: 'Atom', payment_type: 'Internal Transfer', paid_from: 'A - AL', paid_to: 'B - AL', paid_amount: 12345.5, party_type: '', party: null } } });
    expect(await getDraftSummary(c, 'Payment Entry', 'ACC PAY/1')).toEqual({
      doctype: 'Payment Entry', name: 'ACC PAY/1', docstatus: 0, company: 'Atom', paymentType: 'Internal Transfer', paidFrom: 'A - AL', paidTo: 'B - AL',
      paidAmountMinor: 1234550, partyType: null, party: null, totalDebitMinor: null, accounts: [],
    });
    expect(calls[0].url).toBe(`${BASE}/api/resource/Payment%20Entry/ACC%20PAY%2F1`);
  });

  it('a Journal Entry gives its total debit; string amounts parse', async () => {
    const { c } = setup({ body: { data: { name: 'JV-1', docstatus: 1, total_debit: '500.00' } } });
    expect(await getDraftSummary(c, 'Journal Entry', 'JV-1')).toMatchObject({ docstatus: 1, totalDebitMinor: 50000, paymentType: null, accounts: [] });
  });

  it('a Journal Entry gives its account rows (debit/credit in minor units, party when set)', async () => {
    const { c } = setup({ body: { data: { name: 'JV-2', docstatus: 0, total_debit: 500, accounts: [
      { account: 'Drawings - AL', debit_in_account_currency: 500, credit_in_account_currency: 0, party_type: '', party: null },
      { account: 'IDFC CA - AL', debit: '0', credit: '500.00' },
      { account: 'Rent - AL', debit_in_account_currency: 1.5, party_type: 'Supplier', party: 'Sup' },
      null,
    ] } } });
    expect((await getDraftSummary(c, 'Journal Entry', 'JV-2')).accounts).toEqual([
      { account: 'Drawings - AL', debitMinor: 50000, creditMinor: 0, partyType: null, party: null },
      { account: 'IDFC CA - AL', debitMinor: 0, creditMinor: 50000, partyType: null, party: null },
      { account: 'Rent - AL', debitMinor: 150, creditMinor: 0, partyType: 'Supplier', party: 'Sup' },
    ]);
  });

  it('a reply without docstatus is unexpected', async () => {
    const { c } = setup({ body: { data: { name: 'X' } } });
    await expect(getDraftSummary(c, 'Payment Entry', 'X')).rejects.toThrow();
  });
});

describe('deleteDraft', () => {
  it('reads docstatus then deletes', async () => {
    const { c, calls } = setup({ body: { data: { name: 'ACC JV/1', docstatus: 0 } } }, { status: 202, body: { data: 'ok' } });
    await deleteDraft(c, 'Journal Entry', 'ACC JV/1');
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toBe(`${BASE}/api/resource/Journal%20Entry/ACC%20JV%2F1`);
    expect(calls[1].method).toBe('DELETE');
    expect(calls[1].url).toBe(`${BASE}/api/resource/Journal%20Entry/ACC%20JV%2F1`);
  });

  it.each([1, 2])('throws NotDraftError for docstatus %i and never deletes', async (ds) => {
    const { c, calls } = setup({ body: { data: { name: 'X', docstatus: ds } } });
    await expect(deleteDraft(c, 'Payment Entry', 'X')).rejects.toBeInstanceOf(NotDraftError);
    expect(calls).toHaveLength(1);
  });
});

describe('getDocStatuses', () => {
  it('one request per doctype using the in filter', async () => {
    const { c, calls } = setup(
      { body: { data: [{ name: 'A', docstatus: 0 }, { name: 'B', docstatus: 1 }] } },
      { body: { data: [{ name: 'J', docstatus: 2 }] } },
    );
    const r = await getDocStatuses(c, [
      { doctype: 'Payment Entry', name: 'A' },
      { doctype: 'Payment Entry', name: 'B' },
      { doctype: 'Journal Entry', name: 'J' },
      { doctype: 'Journal Entry', name: 'GONE' },
    ]);
    expect(r).toEqual({ 'Payment Entry:A': 0, 'Payment Entry:B': 1, 'Journal Entry:J': 2 });
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(
      `${BASE}/api/resource/Payment%20Entry?${q({ fields: ['name', 'docstatus'], filters: [['name', 'in', ['A', 'B']]], limit_page_length: 0 })}`,
    );
    expect(calls[1].url).toContain('/api/resource/Journal%20Entry?');
  });

  it('empty input makes no request', async () => {
    const { c, calls } = setup({ body: {} });
    expect(await getDocStatuses(c, [])).toEqual({});
    expect(calls).toHaveLength(0);
  });
});

describe('getDocStatuses chunking', () => {
  it('dedupes, chunks 50 per request per doctype, merges', async () => {
    const names = Array.from({ length: 120 }, (_, i) => `N${i}`);
    const refs = [...names, ...names.slice(0, 10)].map((name) => ({ doctype: 'Payment Entry', name }));
    const { c, calls } = setup(
      { body: { data: names.slice(0, 50).map((name) => ({ name, docstatus: 0 })) } },
      { body: { data: names.slice(50, 99).map((name) => ({ name, docstatus: 1 })) } }, // N99 absent
      { body: { data: names.slice(100).map((name) => ({ name, docstatus: 2 })) } },
    );
    const r = await getDocStatuses(c, refs);
    expect(calls).toHaveLength(3);
    const sent = calls.map((x) => (JSON.parse(decodeURIComponent(/filters=([^&]*)/.exec(x.url)![1])) as unknown[][])[0][2] as string[]);
    expect(sent.map((a) => a.length)).toEqual([50, 50, 20]);
    expect(new Set(sent.flat()).size).toBe(120);
    expect(Object.keys(r)).toHaveLength(119);
    expect(r['Payment Entry:N0']).toBe(0);
    expect(r['Payment Entry:N60']).toBe(1);
    expect(r['Payment Entry:N119']).toBe(2);
    expect('Payment Entry:N99' in r).toBe(false);
  });
});

describe('getBankBalance', () => {
  beforeEach(() => jest.useFakeTimers({ now: new Date(2026, 10, 8, 12, 0, 0) }));
  afterEach(() => jest.useRealTimers());

  it('GL Entry SUM in dict form, debit - credit in minor units', async () => {
    const { c, calls } = setup({ body: { message: [{ debit: 2682914.0, credit: 197996.42 }] } });
    expect(await getBankBalance(c, 'IDFC First - ZP', 'ZP Co')).toBe(248491758);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toBe(
      `${BASE}/api/method/frappe.client.get_list?${q({
        doctype: 'GL Entry',
        fields: [{ SUM: 'debit', as: 'debit' }, { SUM: 'credit', as: 'credit' }],
        filters: [['account', '=', 'IDFC First - ZP'], ['company', '=', 'ZP Co'], ['is_cancelled', '=', 0], ['posting_date', '<=', '2026-11-08']],
      })}`,
    );
  });

  it('negative (card owing) and null sums', async () => {
    expect(await getBankBalance(setup({ body: { message: [{ debit: 100.1, credit: 4588.84 }] } }).c, 'Card', 'ZP')).toBe(-448874);
    expect(await getBankBalance(setup({ body: { message: [{ debit: null, credit: null }] } }).c, 'Card', 'ZP')).toBe(0);
  });
});

describe('getReceivablesPayables', () => {
  beforeEach(() => jest.useFakeTimers({ now: new Date(2026, 10, 8, 12, 0, 0) }));
  afterEach(() => jest.useRealTimers());

  // Shape per docs/spike-report.md B.8: object rows per party, then ONE positional array total row; AR and AP column orders differ.
  const arColumns = ['party', 'party_type', 'territory', 'customer_group', 'advance', 'invoiced', 'paid', 'credit_note', 'outstanding', 'currency'].map((fieldname) => ({ fieldname, label: fieldname }));
  const apColumns = ['party', 'party_type', 'supplier_group', 'advance', 'invoiced', 'paid', 'debit_note', 'outstanding', 'currency'].map((fieldname) => ({ fieldname, label: fieldname }));
  const ar = {
    columns: arColumns,
    result: [
      { party: 'Acme', party_type: 'Customer', advance: 510000, invoiced: 1631725, outstanding: 1121725 - 0, currency: 'INR' },
      { party: 'Zed', party_type: 'Customer', advance: 0, invoiced: 100.5, outstanding: 100.5, currency: 'INR' },
      ['Total', '', '', '', 510000, 1731725.5, 0, 0, 1121825.5, ''],
    ],
  };
  const ap = {
    columns: apColumns,
    result: [{ party: 'Bharti', outstanding: 250526 }, ['Total', '', '', 0, 250526, 0, 0, 250526, '']],
  };

  it('reads the positional total row at the outstanding column; runs both reports', async () => {
    const { c, calls } = setup({ body: { message: ar } }, { body: { message: ap } });
    expect(await getReceivablesPayables(c, 'ZP Co')).toEqual({ receivableMinor: 112182550, payableMinor: 25052600 });
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(`${BASE}/api/method/frappe.desk.query_report.run`);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({
      report_name: 'Accounts Receivable Summary',
      filters: { company: 'ZP Co', report_date: '2026-11-08', ageing_based_on: 'Due Date', range: '30, 60, 90, 120' },
      ignore_prepared_report: true,
    });
    expect((calls[1].body as { report_name: string }).report_name).toBe('Accounts Payable Summary');
  });

  it('an empty report is zero; rows without a total row is an error (never summed)', async () => {
    const empty = setup({ body: { message: { columns: arColumns, result: [] } } }, { body: { message: { columns: apColumns, result: [] } } });
    expect(await getReceivablesPayables(empty.c, 'ZP')).toEqual({ receivableMinor: 0, payableMinor: 0 });
    const bad = setup({ body: { message: { columns: arColumns, result: [ar.result[0]] } } });
    await expect(getReceivablesPayables(bad.c, 'ZP')).rejects.toThrow();
  });
});

describe('listBookedEntries', () => {
  // Answers by doctype; each doctype gets its replies in order (the last one repeats).
  function routed(byType: Record<string, unknown[][]>) {
    const calls: { doctype: string; params: Record<string, unknown> }[] = [];
    const seen: Record<string, number> = {};
    const impl = (async (url: string) => {
      const u = new URL(url);
      const doctype = decodeURIComponent(u.pathname.replace('/api/resource/', ''));
      const params: Record<string, unknown> = {};
      u.searchParams.forEach((v, k) => {
        try {
          params[k] = JSON.parse(v);
        } catch {
          params[k] = v;
        }
      });
      calls.push({ doctype, params });
      const pages = byType[doctype] ?? [[]];
      const i = seen[doctype] ?? 0;
      seen[doctype] = i + 1;
      return new Response(JSON.stringify({ data: pages[Math.min(i, pages.length - 1)] }), { status: 200 });
    }) as unknown as typeof fetch;
    return { c: new ErpClient({ siteUrl: BASE, apiKey: 'k', apiSecret: 's', fetchImpl: impl }), calls };
  }

  const pe = (o: Record<string, unknown> = {}) => ({
    name: 'PE-1', posting_date: '2026-11-08', payment_type: 'Pay', paid_amount: 500, received_amount: 500,
    party: 'SUP-1', party_name: 'HP Fuel', reference_no: 'R1', docstatus: 0, company: 'ZP', ...o,
  });

  it('reads Payment Entries, Journal Entries and Purchase Invoices of the company in the date range', async () => {
    const { c, calls } = routed({
      'Payment Entry': [[pe(), pe({ name: 'PE-2', payment_type: 'Receive', paid_amount: 1000.4, received_amount: 1000.4, docstatus: 1 }), pe({ name: 'PE-3', payment_type: 'Internal Transfer', party: null, party_name: null, reference_no: null })]],
      'Journal Entry': [[{ name: 'JE-1', posting_date: '2026-11-07', total_debit: 250.5, cheque_no: 'C1', docstatus: 0, company: 'ZP' }]],
      'Purchase Invoice': [[
        { name: 'PI-1', posting_date: '2026-11-06', base_grand_total: 118, base_rounded_total: 0, supplier: 'SUP-2', supplier_name: 'Facebook', bill_no: 'B9', docstatus: 1, company: 'ZP' },
        { name: 'PI-2', posting_date: '2026-11-06', base_grand_total: 117.6, base_rounded_total: 118, supplier: 'SUP-2', supplier_name: '', bill_no: '', docstatus: 0, company: 'ZP' },
      ]],
    });
    const r = await listBookedEntries(c, 'ZP', '2026-11-01', '2026-11-30');
    expect(r).toEqual([
      { doctype: 'Payment Entry', name: 'PE-1', postingDate: '2026-11-08', amountMinor: 50000, direction: 'out', party: 'HP Fuel', reference: 'R1', docstatus: 0 },
      { doctype: 'Payment Entry', name: 'PE-2', postingDate: '2026-11-08', amountMinor: 100040, direction: 'in', party: 'HP Fuel', reference: 'R1', docstatus: 1 },
      { doctype: 'Payment Entry', name: 'PE-3', postingDate: '2026-11-08', amountMinor: 50000, direction: null, party: null, reference: null, docstatus: 0 },
      { doctype: 'Journal Entry', name: 'JE-1', postingDate: '2026-11-07', amountMinor: 25050, direction: null, party: null, reference: 'C1', docstatus: 0 },
      { doctype: 'Purchase Invoice', name: 'PI-1', postingDate: '2026-11-06', amountMinor: 11800, direction: 'out', party: 'Facebook', reference: 'B9', docstatus: 1 },
      { doctype: 'Purchase Invoice', name: 'PI-2', postingDate: '2026-11-06', amountMinor: 11800, direction: 'out', party: 'SUP-2', reference: null, docstatus: 0 },
    ]);
    expect(calls.map((x) => x.doctype)).toEqual(['Payment Entry', 'Journal Entry', 'Purchase Invoice']);
    for (const call of calls) {
      expect(call.params.filters).toEqual([
        ['company', '=', 'ZP'],
        ['docstatus', 'in', [0, 1]],
        ['posting_date', '>=', '2026-11-01'],
        ['posting_date', '<=', '2026-11-30'],
      ]);
      expect(call.params.limit_start).toBe(0);
    }
  });

  it('ignores rows of another company or cancelled rows even if the server returns them', async () => {
    const { c } = routed({
      'Payment Entry': [[pe({ company: 'Other Co' }), pe({ name: 'PE-X', docstatus: 2 }), pe({ name: 'PE-OK' })]],
    });
    expect((await listBookedEntries(c, 'ZP', '2026-11-01', '2026-11-30')).map((e) => e.name)).toEqual(['PE-OK']);
  });

  it('pages, at most 3 requests per doctype', async () => {
    const full = (p: number) => Array.from({ length: BOOKED_PAGE_SIZE }, (_, i) => pe({ name: `PE-${p}-${i}` }));
    const { c, calls } = routed({ 'Payment Entry': [full(0), full(1), full(2), full(3)], 'Journal Entry': [[]] });
    const r = await listBookedEntries(c, 'ZP', '2026-11-01', '2026-11-30');
    const peCalls = calls.filter((x) => x.doctype === 'Payment Entry');
    expect(peCalls.map((x) => x.params.limit_start)).toEqual([0, BOOKED_PAGE_SIZE, 2 * BOOKED_PAGE_SIZE]);
    expect(peCalls[0].params.limit_page_length).toBe(BOOKED_PAGE_SIZE);
    expect(r).toHaveLength(3 * BOOKED_PAGE_SIZE);
    // A short page ends the doctype after one request.
    expect(calls.filter((x) => x.doctype === 'Journal Entry')).toHaveLength(1);
  });

  it('a failed request rejects', async () => {
    const { c } = setup({ status: 500, body: {} });
    await expect(listBookedEntries(c, 'ZP', '2026-11-01', '2026-11-30')).rejects.toThrow();
  });
});
