# Generic alert webhook payloads

Generic webhook targets send the existing plain-text message by default. To receive JSON, set `payloadFormat` to `"json"` when creating a target with `POST /api/v1/targets`. For example, the following target uses a placeholder Bearer token.

```json
{
  "name": "checkout-automation",
  "type": "webhook",
  "endpoint": "https://automation.example/hook",
  "payloadFormat": "json",
  "headers": {"Authorization": "Bearer REPLACE_ME"}
}
```

Upgrade the servers that save targets and deliver alerts before enabling JSON. The earlier fork build at `63f9a416` sends the text body.

In the dashboard target editor, choose **Webhook**, select **JSON** under **Payload format**, and enter the Bearer header under **Custom headers**. Older header-only forms can submit `X-Parseable-Payload-Format` with value `json`. Parseable consumes that instruction on save. The target API returns the selection in `payloadFormat` and masks the endpoint and outbound header values. Authorization requires a destination that matches the tenant's outbound allowlist.

To edit a target, use the dashboard form or send its full specification to `PUT /api/v1/targets/{id}`. Supply the actual endpoint and desired outbound header values when replacing a target. Omitting the format keeps the current selection. Set the format to `text` to switch back. Both API and form inputs accept `text` and `json`. If both are supplied, they must agree.

JSON delivery sets `Content-Type: application/json` even when a different content type was configured. In text mode, an explicitly configured content type is sent alongside the original text bytes.

## Events

A grouped SQL alert can report several services in one notification. For example, an alert with a string-valued custom field `service` and a query grouped by `service.name` could produce this recovery event.

```json
{
  "status": "resolved",
  "alertId": "01J00000000000000000000000",
  "alertName": "Checkout errors",
  "severity": "High",
  "service": "storefront",
  "series": [{"service.name": "checkout"}],
  "message": "Checkout errors is now `not-triggered` "
}
```

PromQL delivers one event per series transition. The `series` array contains the original labels for that instance, including on recovery while other instances are still firing. Outbox retries carry the status of the queued transition.

For SQL, a firing event has status `firing`, the evaluator's readable message, and the group labels that breached the threshold. A recovery event has status `resolved` and carries the labels from the most recent firing evaluation. Recovery applies to the whole alert. Use `alertId` to correlate events across evaluations. Ungrouped alerts and alerts recovering from a firing recorded before this feature have an empty `series` array. The optional alert field `service` appears as `null` when unspecified.
