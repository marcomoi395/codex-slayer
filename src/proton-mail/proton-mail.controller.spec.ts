import { BadRequestException } from '@nestjs/common';

import { ProtonMailController } from './proton-mail.controller';
import { ProtonMailService } from './proton-mail.service';

describe('ProtonMailController', () => {
  const checkEmail = jest.fn();
  const getLatestOpenAiVerificationCode = jest.fn();
  const startManualLogin = jest.fn();
  const completeManualLogin = jest.fn();
  const service = {
    checkEmail,
    getLatestOpenAiVerificationCode,
    startManualLogin,
    completeManualLogin,
  } as unknown as ProtonMailService;
  const controller = new ProtonMailController(service);

  beforeEach(() => jest.clearAllMocks());

  it('rejects a missing email', () => {
    expect(() => controller.checkEmail({})).toThrow(
      new BadRequestException('email is required'),
    );
  });

  it('delegates email lookup', () => {
    checkEmail.mockReturnValue({ connectionId: null });

    expect(controller.checkEmail({ email: 'user@example.com' })).toEqual({
      connectionId: null,
    });
    expect(checkEmail).toHaveBeenCalledWith('user@example.com');
  });

  it('rejects a missing connection ID', () => {
    expect(() => controller.getVerificationCode({})).toThrow(
      new BadRequestException('credential.connectionId is required'),
    );
  });

  it('passes the optional conversation time query to verification lookup', async () => {
    getLatestOpenAiVerificationCode.mockResolvedValue('123456');

    await expect(
      controller.getVerificationCode(
        { credential: { connectionId: 'proton:user@example.com' } },
        '1700000000',
      ),
    ).resolves.toBe('123456');
    expect(getLatestOpenAiVerificationCode).toHaveBeenCalledWith(
      'proton:user@example.com',
      1700000000,
    );
  });

  it('rejects a non-numeric conversation time query', () => {
    expect(() =>
      controller.getVerificationCode(
        { credential: { connectionId: 'proton:user@example.com' } },
        'not-a-timestamp',
      ),
    ).toThrow(new BadRequestException('time must be a Unix timestamp'));
  });

  it('delegates verification code lookup without a time filter', async () => {
    getLatestOpenAiVerificationCode.mockResolvedValue('123456');

    await expect(
      controller.getVerificationCode({
        credential: { connectionId: 'proton:user@example.com' },
      }),
    ).resolves.toBe('123456');
    expect(getLatestOpenAiVerificationCode).toHaveBeenCalledWith(
      'proton:user@example.com',
    );
  });

  it('starts manual Proton login', () => {
    startManualLogin.mockReturnValue({ status: 'login_started' });

    expect(controller.startLogin()).toEqual({ status: 'login_started' });
    expect(startManualLogin).toHaveBeenCalled();
  });

  it('completes manual Proton login', async () => {
    completeManualLogin.mockResolvedValue({ status: 'login_completed' });

    await expect(controller.completeLogin()).resolves.toEqual({
      status: 'login_completed',
    });
    expect(completeManualLogin).toHaveBeenCalled();
  });
});
