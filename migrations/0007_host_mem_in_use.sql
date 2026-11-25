-- [fork] RAM in use including model files kept in RAM (node_memory_Mapped_bytes):
-- MemTotal - MemAvailable + min(Mapped, MemAvailable). MemAvailable counts the
-- mapped model weights as reclaimable, so mem_used_bytes alone understates how
-- full the box is. Rows written before this migration stay NULL.
ALTER TABLE host_samples ADD COLUMN mem_in_use_bytes REAL;
ALTER TABLE host_samples ADD COLUMN mem_in_use_bytes_max REAL;
