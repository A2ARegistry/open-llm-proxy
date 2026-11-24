-- Streaming speed metrics (gateway-measured, wall clock as seen by the Worker).
-- ttft_ms:   request start -> first output delta (queue + prefill + network).
-- decode_ms: first output delta -> end of stream. NULL for non-streamed
--            requests and for streams the client cancelled.
ALTER TABLE request_metrics ADD COLUMN ttft_ms INTEGER;
ALTER TABLE request_metrics ADD COLUMN decode_ms INTEGER;
