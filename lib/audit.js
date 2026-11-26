import { createServiceClient } from './supabase/server';

/**
 * Penulisan audit_log. Dipakai semua route tulis setelah operasi utama
 * berhasil. Audit TIDAK PERNAH menggagalkan operasi utama: kegagalan
 * audit ditelan (hanya dicatat ke console) — porting auditChange_() GAS.
 */
export async function writeAudit({ actorId, action, entity, entityId }) {
  try {
    if (!actorId || !action || !entity) return;
    const service = createServiceClient();
    const { error } = await service.from('audit_log').insert({
      actor_user_id: actorId,
      action,
      entity,
      entity_id: entityId == null ? null : String(entityId),
    });
    if (error) {
      console.error('SIA audit gagal ditulis:', action, entity, error.message);
    }
  } catch (error) {
    console.error('SIA audit gagal ditulis:', action, entity, error.message);
  }
}
