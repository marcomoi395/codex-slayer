export interface SmsPoolBalanceResponse {
  balance?: number | string;
  currency?: string;
}

export interface SmsPoolOrderResponse {
  order_id?: string;
  orderid?: string;
  phone_number?: string | number;
  number?: string | number;
  phone?: string | number;
  phoneNumber?: string | number;
  phonenumber?: string | number;
  expires_at?: number | string;
  expiry?: number | string;
  expires_in?: number | string;
  data?: SmsPoolOrderResponse;
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
