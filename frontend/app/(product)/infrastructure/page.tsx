"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { useOperatorSession } from "../../../lib/session";
import { StatusBadge } from "../../../components/StatusBadge";
import { ErrorState, EmptyState } from "../../../components/States";

interface Source<T> { status: string; errorCode?: string; items: T[]; telemetry?: { status: string; errorCode?: string; window?: string } }
interface Ec2Metrics { cpuAveragePercent1h: number | null; networkInBytes1h: number | null; networkOutBytes1h: number | null; statusCheckFailedMax1h: number | null }
interface RdsMetrics { cpuAveragePercent1h: number | null; databaseConnectionsAverage1h: number | null; freeStorageBytesAverage1h: number | null; freeableMemoryBytesAverage1h: number | null }
interface LambdaMetrics { invocations24h: number | null; errors24h: number | null; throttles24h: number | null; durationAverageMs24h: number | null }
interface S3Metrics { region: string | null; regionStatus: string; numberOfObjects: number | null; standardStorageBytes: number | null }
interface AwsInventory {
  provider: string;
  region: string;
  identity?: { mode: string; serverSideOnly: boolean };
  telemetryLimits?: { maxTelemetryResourcesPerService: number; truncated: Record<string, boolean> };
  services: {
    cognito: Source<{ id: string | null; name: string | null; status: string | null }>;
    s3: Source<{ name: string | null; createdAt: string | null; metrics?: S3Metrics | null }>;
    ec2: Source<{ instanceId: string | null; name: string | null; instanceType: string | null; state: string | null; availabilityZone: string | null; architecture?: string | null; vpcId?: string | null; subnetId?: string | null; privateIpAddress?: string | null; publicIpAssigned?: boolean; monitoringState?: string | null; launchTime?: string | null; metrics?: Ec2Metrics | null }>;
    rds: Source<{ identifier: string | null; engine: string | null; engineVersion: string | null; instanceClass: string | null; status: string | null; availabilityZone: string | null; multiAz: boolean; allocatedStorageGiB: number | null; storageType?: string | null; storageEncrypted?: boolean; backupRetentionDays?: number | null; deletionProtection?: boolean; performanceInsightsEnabled?: boolean; publiclyAccessible?: boolean; metrics?: RdsMetrics | null }>;
    lambda: Source<{ functionName: string | null; runtime: string | null; memoryMb: number | null; timeoutSeconds: number | null; codeSizeBytes?: number | null; architectures?: string[]; packageType?: string | null; lastModified?: string | null; metrics?: LambdaMetrics | null }>;
    scheduler: Source<{ name: string | null; groupName: string | null; state: string | null; targetArn: string | null }>;
    ebs?: Source<{ volumeId: string | null; sizeGiB: number | null; volumeType: string | null; state: string | null; encrypted: boolean; iops: number | null; throughput: number | null; availabilityZone: string | null; attachedInstanceIds: string[] }>;
    cloudwatch?: Source<{ alarmName: string | null; namespace: string | null; metricName: string | null; stateValue: string | null; stateUpdatedAt: string | null }>;
  };
}
interface AzureManagementIdentity { status: string; mode: string; subscriptionConfigured: boolean; resourceGroupScoped: boolean; serverSideOnly: boolean }
interface ContainerAppSource extends Source<{ name: string | null; resourceGroup: string | null; location: string | null; provisioningState: string | null; runningStatus: string | null; latestRevisionName: string | null; environmentName: string | null; ingressHost: string | null; ingressExternal: boolean; managedIdentity: boolean }> { product: string; purpose: string; managementIdentity?: AzureManagementIdentity }
interface ServiceBusSource extends Source<{ name: string; activeMessages: number; deadLetterMessages: number; scheduledMessages: number; totalMessages: number }> { product: string; purpose: string; namespaceHost: string | null; queuePrefix: string | null }
interface StirlingSource { status: string; errorCode?: string; product: string; purpose: string; hosting: string; region: string; regionHint?: string; endpointHost: string | null; authMode: string; version: string | null; evidence?: string }
interface Inventory { contractVersion: string; aws: AwsInventory; azure: { provider: string; managementIdentity?: AzureManagementIdentity; services: { containerApps?: ContainerAppSource; serviceBus: ServiceBusSource; stirling: StirlingSource } }; observedAt: string; source: string; freshness: string }

const when = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";
const statusLabel = (status: string) => status.replace(/_/g, " ");
const countLabel = <T,>(source: Source<T> | undefined) => source?.status === "live" ? String(source.items.length) : "Unknown";
const num = (value: number | null | undefined, digits = 1) => value == null || !Number.isFinite(value) ? "—" : new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(value);
const percent = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? "—" : `${value.toFixed(1)}%`;
const bytes = (value: number | null | undefined) => {
  if (value == null || !Number.isFinite(value)) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let n = value; let i = 0;
  while (Math.abs(n) >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n.toFixed(i >= 3 ? 2 : 1)} ${units[i]}`;
};

function SourceState({ status, errorCode }: { status: string; errorCode?: string }) {
  return <span title={errorCode ? `Source error: ${errorCode}` : undefined}><StatusBadge value={statusLabel(status)} /></span>;
}
function Metric({ label, value, note }: { label: string; value: string; note?: string }) {
  return <div className="card" style={{ padding: "0.85rem 1rem" }}><div className="overlay-note" style={{ marginTop: 0 }}>{label}</div><div style={{ fontSize: "1.25rem", fontWeight: 650, marginTop: "0.2rem" }}>{value}</div>{note && <div className="overlay-note" style={{ marginTop: "0.15rem" }}>{note}</div>}</div>;
}

export default function InfrastructurePage() {
  const { request } = useOperatorSession();
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await request("/management/v1/infrastructure");
      if (!res.ok) { setError(res.status === 403 ? "You need runtime.read to view infrastructure inventory." : "Could not load infrastructure inventory."); return; }
      setInventory(await res.json());
    } catch { setError("Could not load infrastructure inventory."); }
  }, [request]);
  useEffect(() => { void load(); }, [load]);

  const aws = inventory?.aws.services;
  const apps = inventory?.azure.services.containerApps;
  const bus = inventory?.azure.services.serviceBus;
  const stirling = inventory?.azure.services.stirling;
  const azureIdentity = inventory?.azure.managementIdentity;

  const awsSummary = useMemo(() => {
    if (!aws) return null;
    const ec2Cpu = aws.ec2.items.map((item) => item.metrics?.cpuAveragePercent1h).filter((v): v is number => typeof v === "number");
    const rdsCpu = aws.rds.items.map((item) => item.metrics?.cpuAveragePercent1h).filter((v): v is number => typeof v === "number");
    const lambdaInvocations = aws.lambda.items.reduce((sum, item) => sum + (item.metrics?.invocations24h ?? 0), 0);
    const ebsGiB = (aws.ebs?.items ?? []).reduce((sum, item) => sum + (item.sizeGiB ?? 0), 0);
    const s3Bytes = aws.s3.items.reduce((sum, item) => sum + (item.metrics?.standardStorageBytes ?? 0), 0);
    return {
      ec2Cpu: ec2Cpu.length ? ec2Cpu.reduce((a, b) => a + b, 0) / ec2Cpu.length : null,
      rdsCpu: rdsCpu.length ? rdsCpu.reduce((a, b) => a + b, 0) / rdsCpu.length : null,
      lambdaInvocations,
      ebsGiB,
      s3Bytes,
      alarms: aws.cloudwatch?.status === "live" ? aws.cloudwatch.items.length : null,
    };
  }, [aws]);

  const deadLetters = bus?.status === "live" ? String(bus.items.reduce((n, q) => n + q.deadLetterMessages, 0)) : "Unknown";

  return (
    <>
      <div className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: "1rem" }}>
        <div><h1 className="text-display">Infrastructure</h1><p>Read-only operational inventory, capacity and runtime health across AWS and Azure.</p></div>
        <button className="btn" onClick={() => void load()}>Refresh</button>
      </div>
      {error && <ErrorState label={error} />}
      {inventory && aws && awsSummary && bus && stirling && (
        <>
          <p className="overlay-note" style={{ marginTop: 0 }}>Observed {when(inventory.observedAt)} · source {inventory.source} · {inventory.freshness}. Cloud credentials remain server-side; denied telemetry is shown as unknown rather than zero.</p>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(11rem, 1fr))", gap: "0.75rem", margin: "0.85rem 0 1rem" }}>
            <Metric label="EC2 CPU · 1h avg" value={percent(awsSummary.ec2Cpu)} note={`${countLabel(aws.ec2)} instance(s) · ${inventory.aws.region}`} />
            <Metric label="RDS CPU · 1h avg" value={percent(awsSummary.rdsCpu)} note={`${countLabel(aws.rds)} database(s)`} />
            <Metric label="Lambda invocations · 24h" value={num(awsSummary.lambdaInvocations, 0)} note={`${countLabel(aws.lambda)} function(s)`} />
            <Metric label="EBS allocated" value={`${num(awsSummary.ebsGiB, 0)} GiB`} note={`${countLabel(aws.ebs)} volume(s)`} />
            <Metric label="S3 standard storage" value={bytes(awsSummary.s3Bytes)} note={`${countLabel(aws.s3)} bucket(s) · daily metric`} />
            <Metric label="Active CloudWatch alarms" value={awsSummary.alarms == null ? "Unknown" : String(awsSummary.alarms)} note={aws.cloudwatch?.status === "live" ? "state = ALARM" : `collector ${statusLabel(aws.cloudwatch?.status ?? "unavailable")}`} />
          </div>

          <h3 className="text-subhead" style={{ margin: "1.1rem 0 0.5rem" }}>AWS compute · {inventory.aws.region}</h3>
          {aws.ec2.status !== "live" ? <ErrorState label={`EC2 inventory is ${statusLabel(aws.ec2.status)}.`} /> : aws.ec2.items.length === 0 ? <EmptyState label="No EC2 instances observed." icon="dns" /> : (
            <table className="data-table"><thead><tr><th>Instance</th><th>Runtime</th><th>CPU · 1h</th><th>Network · 1h</th><th>Status checks</th><th>Placement</th></tr></thead><tbody>
              {aws.ec2.items.map((item) => <tr key={item.instanceId ?? item.name ?? "instance"}>
                <td><strong>{item.name ?? item.instanceId ?? "instance"}</strong><div className="overlay-note" style={{ marginTop: 0 }}>{item.instanceId ?? "—"}</div></td>
                <td>{item.instanceType ?? "—"} · {item.state ?? "—"}<div className="overlay-note" style={{ marginTop: 0 }}>{item.architecture ?? "architecture unknown"} · monitoring {item.monitoringState ?? "unknown"}</div></td>
                <td>{percent(item.metrics?.cpuAveragePercent1h)}<div className="overlay-note" style={{ marginTop: 0 }}>CloudWatch average</div></td>
                <td>↓ {bytes(item.metrics?.networkInBytes1h)} · ↑ {bytes(item.metrics?.networkOutBytes1h)}</td>
                <td>{item.metrics?.statusCheckFailedMax1h == null ? "—" : item.metrics.statusCheckFailedMax1h === 0 ? "Healthy" : `${item.metrics.statusCheckFailedMax1h} failed`}</td>
                <td>{item.availabilityZone ?? "—"}<div className="overlay-note" style={{ marginTop: 0 }}>{item.vpcId ?? "VPC unknown"} · {item.subnetId ?? "subnet unknown"}</div></td>
              </tr>)}
            </tbody></table>
          )}
          {aws.ec2.telemetry?.status !== "live" && <p className="overlay-note">EC2 runtime telemetry: {statusLabel(aws.ec2.telemetry?.status ?? "unavailable")}{aws.ec2.telemetry?.errorCode ? ` · ${aws.ec2.telemetry.errorCode}` : ""}.</p>}

          <h3 className="text-subhead" style={{ margin: "1.25rem 0 0.5rem" }}>AWS database</h3>
          {aws.rds.status !== "live" ? <ErrorState label={`RDS inventory is ${statusLabel(aws.rds.status)}.`} /> : aws.rds.items.length === 0 ? <EmptyState label="No RDS instances observed." icon="database" /> : (
            <table className="data-table"><thead><tr><th>Database</th><th>Engine / class</th><th>CPU · 1h</th><th>Connections · 1h</th><th>Storage</th><th>Protection</th></tr></thead><tbody>
              {aws.rds.items.map((item) => <tr key={item.identifier ?? "database"}>
                <td><strong>{item.identifier ?? "database"}</strong><div className="overlay-note" style={{ marginTop: 0 }}>{item.status ?? "—"} · {item.availabilityZone ?? "—"}</div></td>
                <td>{item.engine ?? "—"} {item.engineVersion ?? ""}<div className="overlay-note" style={{ marginTop: 0 }}>{item.instanceClass ?? "—"} · {item.multiAz ? "Multi-AZ" : "Single-AZ"}</div></td>
                <td>{percent(item.metrics?.cpuAveragePercent1h)}</td>
                <td>{num(item.metrics?.databaseConnectionsAverage1h)}</td>
                <td>{item.allocatedStorageGiB ?? "—"} GiB {item.storageType ?? ""}<div className="overlay-note" style={{ marginTop: 0 }}>free {bytes(item.metrics?.freeStorageBytesAverage1h)} · memory {bytes(item.metrics?.freeableMemoryBytesAverage1h)}</div></td>
                <td>{item.storageEncrypted ? "Encrypted" : "Encryption not observed"}<div className="overlay-note" style={{ marginTop: 0 }}>{item.backupRetentionDays ?? "?"}d backups · deletion protection {item.deletionProtection ? "on" : "off"}</div></td>
              </tr>)}
            </tbody></table>
          )}

          <h3 className="text-subhead" style={{ margin: "1.25rem 0 0.5rem" }}>AWS serverless</h3>
          {aws.lambda.status === "live" && aws.lambda.items.length > 0 ? <table className="data-table"><thead><tr><th>Function</th><th>Runtime</th><th>Invocations · 24h</th><th>Errors</th><th>Throttles</th><th>Duration</th></tr></thead><tbody>{aws.lambda.items.map((fn) => {
            const inv = fn.metrics?.invocations24h ?? 0; const err = fn.metrics?.errors24h ?? 0; const rate = inv > 0 ? (err / inv) * 100 : 0;
            return <tr key={fn.functionName ?? "function"}><td><strong>{fn.functionName ?? "function"}</strong><div className="overlay-note" style={{ marginTop: 0 }}>{fn.memoryMb ?? "?"} MB · {fn.timeoutSeconds ?? "?"}s timeout</div></td><td>{fn.runtime ?? "—"}<div className="overlay-note" style={{ marginTop: 0 }}>{fn.architectures?.join(", ") || "architecture unknown"}</div></td><td>{num(fn.metrics?.invocations24h, 0)}</td><td>{num(err, 0)}{inv > 0 ? ` · ${rate.toFixed(1)}%` : ""}</td><td>{num(fn.metrics?.throttles24h, 0)}</td><td>{fn.metrics?.durationAverageMs24h == null ? "—" : `${num(fn.metrics.durationAverageMs24h)} ms`}</td></tr>;
          })}</tbody></table> : <EmptyState label="No Lambda functions observed." icon="bolt" />}

          <h3 className="text-subhead" style={{ margin: "1.25rem 0 0.5rem" }}>AWS storage</h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(26rem, 1fr))", gap: "0.85rem" }}>
            <div className="card"><strong>S3 buckets</strong>{aws.s3.status === "live" && aws.s3.items.length > 0 ? <table className="data-table" style={{ marginTop: "0.5rem" }}><thead><tr><th>Bucket</th><th>Region</th><th>Objects</th><th>Standard storage</th></tr></thead><tbody>{aws.s3.items.map((bucket) => <tr key={bucket.name ?? "bucket"}><td>{bucket.name ?? "bucket"}</td><td>{bucket.metrics?.region ?? "—"}</td><td>{num(bucket.metrics?.numberOfObjects, 0)}</td><td>{bytes(bucket.metrics?.standardStorageBytes)}</td></tr>)}</tbody></table> : <p className="overlay-note">S3 inventory {statusLabel(aws.s3.status)}.</p>}</div>
            <div className="card"><strong>EBS volumes</strong>{aws.ebs?.status === "live" && aws.ebs.items.length > 0 ? <table className="data-table" style={{ marginTop: "0.5rem" }}><thead><tr><th>Volume</th><th>Size</th><th>Type</th><th>State</th><th>Attached to</th></tr></thead><tbody>{aws.ebs.items.map((volume) => <tr key={volume.volumeId ?? "volume"}><td>{volume.volumeId ?? "volume"}<div className="overlay-note" style={{ marginTop: 0 }}>{volume.encrypted ? "encrypted" : "encryption not observed"}</div></td><td>{volume.sizeGiB ?? "—"} GiB</td><td>{volume.volumeType ?? "—"}</td><td>{volume.state ?? "—"}</td><td>{volume.attachedInstanceIds.join(", ") || "—"}</td></tr>)}</tbody></table> : <p className="overlay-note">EBS inventory {statusLabel(aws.ebs?.status ?? "unavailable")}.</p>}</div>
          </div>

          <h3 className="text-subhead" style={{ margin: "1.25rem 0 0.5rem" }}>AWS control-plane health</h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(22rem, 1fr))", gap: "0.85rem" }}>
            <div className="card"><div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem" }}><strong>CloudWatch alarms</strong><SourceState status={aws.cloudwatch?.status ?? "unavailable"} errorCode={aws.cloudwatch?.errorCode} /></div>{aws.cloudwatch?.status === "live" && aws.cloudwatch.items.length === 0 ? <p className="overlay-note">No alarms are currently in ALARM state.</p> : aws.cloudwatch?.status === "live" ? <table className="data-table" style={{ marginTop: "0.5rem" }}><thead><tr><th>Alarm</th><th>Metric</th><th>Updated</th></tr></thead><tbody>{aws.cloudwatch.items.map((alarm) => <tr key={alarm.alarmName ?? `${alarm.namespace}:${alarm.metricName}`}><td>{alarm.alarmName ?? "alarm"}</td><td>{alarm.namespace ?? "—"} · {alarm.metricName ?? "—"}</td><td>{when(alarm.stateUpdatedAt)}</td></tr>)}</tbody></table> : <p className="overlay-note">Alarm coverage unavailable.</p>}</div>
            <div className="card"><strong>Other AWS inventory</strong><table className="data-table" style={{ marginTop: "0.5rem" }}><tbody><tr><td>Cognito pools</td><td>{countLabel(aws.cognito)}</td></tr><tr><td>EventBridge schedules</td><td>{countLabel(aws.scheduler)}</td></tr><tr><td>Telemetry cap</td><td>{inventory.aws.telemetryLimits?.maxTelemetryResourcesPerService ?? "—"} resources / service</td></tr></tbody></table></div>
          </div>

          <h3 className="text-subhead" style={{ margin: "1.4rem 0 0.5rem" }}>Azure runtime dependencies</h3>
          <div style={{ display: "grid", gap: "0.85rem" }}>
            <div className="card"><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.75rem" }}><strong>Azure management plane</strong><SourceState status={azureIdentity?.status ?? "not_configured"} /></div><p className="overlay-note">Mode: {statusLabel(azureIdentity?.mode ?? "none")} · subscription configured: {azureIdentity?.subscriptionConfigured ? "yes" : "no"} · resource-group scoped: {azureIdentity?.resourceGroupScoped ? "yes" : "no"} · server-side only: {azureIdentity?.serverSideOnly === false ? "no" : "yes"}.</p></div>
            <div className="card"><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.75rem" }}><strong>Azure Container Apps</strong><SourceState status={apps?.status ?? "not_configured"} errorCode={apps?.errorCode} /></div>{apps?.status === "live" && apps.items.length > 0 ? <table className="data-table" style={{ marginTop: "0.5rem" }}><thead><tr><th>App</th><th>Location</th><th>State</th><th>Environment</th><th>Ingress</th></tr></thead><tbody>{apps.items.map((app) => <tr key={`${app.resourceGroup}:${app.name}`}><td>{app.name ?? "container app"}</td><td>{app.location ?? "—"}</td><td>{app.runningStatus ?? app.provisioningState ?? "—"}</td><td>{app.environmentName ?? "—"}</td><td>{app.ingressHost ?? "—"}</td></tr>)}</tbody></table> : <p className="overlay-note">Container Apps coverage is {statusLabel(apps?.status ?? "not_configured")}.</p>}</div>
            <div className="card"><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.75rem" }}><strong>Azure Service Bus</strong><SourceState status={bus.status} errorCode={bus.errorCode} /></div><p className="overlay-note">Namespace: {bus.namespaceHost ?? "not configured"} · dead letters {deadLetters}. Connection material is never returned.</p>{bus.status === "live" && bus.items.length > 0 && <table className="data-table"><thead><tr><th>Queue</th><th>Active</th><th>Scheduled</th><th>Dead letter</th><th>Total</th></tr></thead><tbody>{bus.items.map((q) => <tr key={q.name}><td>{q.name}</td><td>{q.activeMessages}</td><td>{q.scheduledMessages}</td><td>{q.deadLetterMessages}</td><td>{q.totalMessages}</td></tr>)}</tbody></table>}</div>
            <div className="card"><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.75rem" }}><strong>Stirling-PDF · Azure Container Apps runtime</strong><SourceState status={stirling.status} errorCode={stirling.errorCode} /></div><p className="overlay-note">{stirling.region} · endpoint {stirling.endpointHost ?? "not configured"} · authentication {stirling.authMode.replace(/_/g, " ")} · version {stirling.version ?? "not observed"}.</p></div>
          </div>
        </>
      )}
    </>
  );
}
