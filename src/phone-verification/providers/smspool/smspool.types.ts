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

export interface SmsPoolActiveOrderResponse {
  id?: number;
  order_code?: string;
  phonenumber?: string | number;
  cc?: string;
  code?: string;
  country?: string;
  service?: string;
  service_id?: number | string;
  status?: string;
  cost?: number | string;
  can_refund?: boolean;
  can_resend?: boolean;
  can_reactivate?: boolean;
  can_archive?: boolean;
  expiry?: number | string;
  full_code?: string;
}

export interface SmsPoolOrder {
  id?: number;
  orderId: string;
  phoneNumber: string;
  countryCode?: string;
  code?: string | null;
  country?: string;
  service?: string;
  serviceId?: number;
  status?: string;
  cost?: number;
  canRefund?: boolean;
  canResend?: boolean;
  canReactivate?: boolean;
  canArchive?: boolean;
  expiresAt?: number;
  fullCode?: string;
}

export interface SmsPoolCancelResponse {
  success?: boolean;
  refunded?: boolean;
  order_id?: string;
  orderid?: string;
}
