export interface SmsPoolBalanceResponse {
  balance?: number | string;
  currency?: string;
}

export interface SmsPoolOrderResponse {
  order_id?: string;
  orderid?: string;
  phone_number?: string;
  number?: string;
  expires_at?: number;
  expiry?: number;
}

export interface SmsPoolOrder {
  orderId: string;
  phoneNumber: string;
  code?: string | null;
  expiresAt?: number;
}

export interface SmsPoolCancelResponse {
  success?: boolean;
  refunded?: boolean;
  order_id?: string;
  orderid?: string;
}
