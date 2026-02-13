-- Trigger to notify changes via WebSocket
-- This trigger executes when there are changes in important tables

CREATE OR REPLACE FUNCTION notify_rapidin_changes()
RETURNS TRIGGER AS $$
DECLARE
    payload JSON;
BEGIN
    payload = json_build_object(
        'table', TG_TABLE_NAME,
        'action', TG_OP,
        'id', COALESCE(NEW.id, OLD.id)::text
    );
    
    PERFORM pg_notify('rapidin_changes', payload::text);
    
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Apply trigger to important tables
CREATE TRIGGER module_rapidin_loan_requests_notify
    AFTER INSERT OR UPDATE OR DELETE ON module_rapidin_loan_requests
    FOR EACH ROW EXECUTE FUNCTION notify_rapidin_changes();

CREATE TRIGGER module_rapidin_loans_notify
    AFTER INSERT OR UPDATE OR DELETE ON module_rapidin_loans
    FOR EACH ROW EXECUTE FUNCTION notify_rapidin_changes();

CREATE TRIGGER module_rapidin_payments_notify
    AFTER INSERT OR UPDATE OR DELETE ON module_rapidin_payments
    FOR EACH ROW EXECUTE FUNCTION notify_rapidin_changes();

CREATE TRIGGER module_rapidin_installments_notify
    AFTER INSERT OR UPDATE OR DELETE ON module_rapidin_installments
    FOR EACH ROW EXECUTE FUNCTION notify_rapidin_changes();

CREATE TRIGGER module_rapidin_notifications_notify
    AFTER INSERT OR UPDATE ON module_rapidin_notifications
    FOR EACH ROW EXECUTE FUNCTION notify_rapidin_changes();








