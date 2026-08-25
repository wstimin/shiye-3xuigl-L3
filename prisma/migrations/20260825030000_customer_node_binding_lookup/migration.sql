-- The application serializes binding changes per service node and uses this
-- index to reject one official client being assigned to multiple local users.
CREATE INDEX `customer_nodes_serviceNodeId_xuiEmail_idx`
  ON `customer_nodes`(`serviceNodeId`, `xuiEmail`);
