-- One real purchase, one financial truth, across Chat and the dashboard
-- (G-89, under OD-23 / OWN-21).
--
-- A dashboard purchase order receive was idempotent only for the PO itself:
-- a purchase already booked in Chat could be booked a second time when its
-- PO was marked received. A receive is now compared with the stock
-- purchases booked in Chat, by the same policy and under the same lock as a
-- chat yes, and a possible duplicate is ASKED: SAME or SEPARATE.
--
-- SAME writes no purchase, stock, cash, bank, payable, bill or posting. The
-- order is marked `received` and points at the Chat purchase it turned out
-- to be, so it is no longer an outstanding task and cannot be received
-- again. Null on every other order, including one received with its own
-- purchase (that purchase names the order through its own source).
ALTER TABLE orders ADD COLUMN received_expense_id uuid;

-- Another tenant's purchase is unrepresentable, as with every link.
ALTER TABLE orders
  ADD CONSTRAINT orders_received_expense_business_fk
  FOREIGN KEY (business_id, received_expense_id) REFERENCES expenses (business_id, id);

-- One Chat purchase is the delivery of at most one order. A second order
-- answered SAME against it is refused, never silently double-linked.
CREATE UNIQUE INDEX orders_received_expense_ux
  ON orders (business_id, received_expense_id)
  WHERE received_expense_id IS NOT NULL;
