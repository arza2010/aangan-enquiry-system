/** A scheduling backend. Cal.com today; the interface keeps Calendly / Google Calendar a drop-in later. */
export interface ProviderBooking {
  uid: string;
  start: string; // ISO UTC
  end: string;
  status: string; // accepted | pending | cancelled | rejected
  createdAt: string;
  attendeeName?: string;
  attendeePhone?: string;
}

export interface BookingProvider {
  name: string;
  /** Available consult start times (ISO) between two instants. */
  getSlots(fromIso: string, toIso: string): Promise<string[]>;
  book(a: { start: string; name: string; phone: string; callRef: string }): Promise<{ uid: string; start: string; end: string }>;
  cancel(uid: string, reason: string): Promise<void>;
  get(uid: string): Promise<ProviderBooking | null>;
  /** Bookings created within a window: used to find the one Vaani made during a call. */
  listCreatedBetween(fromIso: string, toIso: string): Promise<ProviderBooking[]>;
}
