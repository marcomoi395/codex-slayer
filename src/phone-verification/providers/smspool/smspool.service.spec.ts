import { SmsPoolService } from './smspool.service';

const config = {
  apiKey: 'test-key',
  baseUrl: 'https://api.smspool.test',
  pollIntervalMs: 0,
  pollTimeoutMs: 50,
};

describe('SmsPoolService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('purchases a phone with the provider options and API key', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          order_id: 'order-1',
          phone_number: '15550000000',
          expiry: 1_786_842_831,
        }),
        { status: 200 },
      ),
    );
    const service = new SmsPoolService(config);

    const result = await service.getPhoneNumber();
    const request = fetchMock.mock.calls[0][1];
    const body = new URLSearchParams(
      (request?.body as URLSearchParams).toString(),
    );

    expect(result).toEqual({
      orderId: 'order-1',
      phoneNumber: '15550000000',
      expiresAt: 1_786_842_831,
    });
    expect(body.get('country')).toBe('1');
    expect(body.get('service')).toBe('671');
    expect(body.get('quantity')).toBe('1');
    expect(body.get('pricing_option')).toBe('0');
    expect(body.get('key')).toBe('test-key');
  });

  it('maps the documented SMSPool purchase response shape', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          success: 1,
          data: {
            order_id: 'order-2',
            number: 15550000001,
            expires_in: 599,
          },
        }),
        { status: 200 },
      ),
    );
    const service = new SmsPoolService(config);

    await expect(service.getPhoneNumber()).resolves.toMatchObject({
      orderId: 'order-2',
      phoneNumber: '15550000001',
    });
  });

  it('polls orders until the requested order receives a code', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([{ order_id: 'order-1', number: '15550000000' }]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { order_id: 'order-1', number: '15550000000', code: '123456' },
          ]),
          { status: 200 },
        ),
      );
    const service = new SmsPoolService(config);

    await expect(service.getCode('order-1')).resolves.toEqual({
      code: '123456',
      received: true,
    });
  });
});
