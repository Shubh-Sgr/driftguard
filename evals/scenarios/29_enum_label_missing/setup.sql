-- Enum type missing a label on target
DROP TYPE card_status;
CREATE TYPE card_status AS ENUM ('active', 'closed');
