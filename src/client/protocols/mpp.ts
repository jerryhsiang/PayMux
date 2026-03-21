import type { PaymentRequirement, PaymentResult, WalletConfig } from '../../shared/types.js';

/**
 * MPP payment client — coming in v0.2.0.
 *
 * MPP (Machine Payments Protocol) by Stripe/Tempo will be fully integrated
 * in the next release. This stub exists so the protocol detector can identify
 * MPP endpoints and provide a clear error message.
 *
 * See: https://mpp.dev/overview
 */
export class MppClient {
  constructor(private _walletConfig: WalletConfig) {}

  async pay(
    _url: string,
    _init?: RequestInit,
    _requirement?: PaymentRequirement
  ): Promise<{ response: Response; result: PaymentResult }> {
    throw new Error(
      'PayMux: MPP protocol support ships in v0.2.0. ' +
        'Use x402 endpoints for now, or check https://paymux.dev for updates.'
    );
  }

  canHandle(requirement: PaymentRequirement): boolean {
    return requirement.protocol === 'mpp';
  }
}
