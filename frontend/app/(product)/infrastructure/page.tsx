"use client";

import { useCallback, useEffect, useState } from "react";

import { useOperatorSession } from "../../../lib/session";
import { StatusBadge } from "../../../components/StatusBadge";
import { ErrorState } from "../../../components/States";

interface Source<T> { status: string; errorCode?: string; items: T[] }
interface AwsInventory {
  provider: string;
  region: string;
  identity?: { mode: string; serverSideOnly: boolean };
  services: {
    cognito: Source<{ id: string | null; name: string | null; status: string | null }>;
    s3: Source<{ name: string | null; createdAt: string | null }>;
    ec2: Source<{ instanceId: string | null; name: string | null; instanceType: string | null; state: string | null; availabilityZone: string | null }>;
    rds: Source<{ identifier: string | null; engine: string | null; engineVersion: string | null; instanceClass: string | null; status: string | null; availabilityZone: string | null; multiAz: boolean; allocatedStorageGiB: number | null }>;
    lambda: Source<{ functionName: string | null; runtime: string | null; memoryMb: number | null; timeoutSeconds: number | null }>;
    scheduler: Source<{ name: string | null; groupName: string | null; state: string | null; targetArn: string | null }>;
  };
}
interface AzureManagementIdentity { status: string; mode: string; subscriptionConfigured: boolean; resourceGroupScoped: boolean; serverSideOnly: boolean }
interface ContainerAppSource extends Source<{ name: string | null; resourceGroup: string | null; location: string | null; provisioningState: string | null; runningStatus: string | null; latestRevisionName: string | null; environmentName: string | null; ingressHost: string | null; ingressExternal: boolean; managedIdentity: boolean }> {
  product: string;
  purpose: string;
  managementIdentity?: AzureManagementIdentity;
}
interface ServiceBusSource extends Source<{ name: string; activeMessages: number; deadLetterMessages: number; scheduledMessages: number; totalMessages: number }> {
  product: string; purpose: string; namespaceHost: string | null; queuePrefix: string | null;
}
interface StirlingSource { status: string; errorCode?: string; product: string; purpose: string; hosting: string; region: string; regionHint?: string; endpointHost: string | null; authMode: string; version: string | null; evidence?: string }
interface Inventory {
  contractVersion: string;
  aws: AwsInventory;
  azure: { provider: string; managementIdentity?: AzureManagementIdentity; services: { containerApps?: ContainerAppSource; serviceBus: ServiceBusSource; stirling: StirlingSource } };
  observedAt: string;
  source: string;
  freshness: string;
}

const when = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";
const statusLabel = (status: string) => status.replace(/_/g, " ");
const countLabel = <T,>(source: Source<T> | undefined) => source?.status === "live" ? String(source.items.length) : "Unknown";

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
  const totalAwsObserved = aws ? Object.values(aws).filter((source) => source.status === "live").reduce((n, source) => n + source.items.length, 0) : 0;
  const awsCoverage = aws ? Object.values(aws).filter((source) => source.status === "live").length : 0;
  const deadLetters = bus?.status === "live" ? String(bus.items.reduce((n, q) => n + q.deadLetterMessages, 0)) : "Unknown";

  return (
    <>
      <div className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: "1rem" }}>
        <div><h1 className="text-display">Infrastructure</h1><p>Read-only deployment inventory and runtime dependency health across AWS and Azure.</p></div>
        <button className="btn" onClick={() => void load()}>Refresh</button>
      </div>
      {error && <ErrorState label={error} />}
      {inventory && (
        <>
          <p className="overlay-note" style={{ marginTop: 0 }}>Observed {when(inventory.observedAt)} · source {inventory.source} · {inventory.freshness}. A denied or unconfigured collector is shown as unknown coverage, never as “zero resources”. Cloud credentials remain server-side.</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(11rem, 1fr))", gap: "0.75rem", margin: "0.85rem 0 1rem" }}>
            <Metric label="AWS resources observed" value={String(totalAwsObserved)} note={`${awsCoverage}/6 collectors live · ${inventory.aws.region}`} />
            <Metric label="Azure Container Apps" value={countLabel(apps)} note={apps?.status === "live" ? "management-plane inventory" : statusLabel(apps?.status ?? "unavailable")} />
            <Metric label="Azure document queues" value={countLabel(bus)} note={bus?.namespaceHost ?? "namespace not available"} />
            <Metric label="Document dead letters" value={deadLetters} note="Azure Service Bus" />
            <Metric label="Stirling processor" value={stirling?.version ?? "Not observed"} note={stirling ? `${stirling.hosting} · ${stirling.region}` : undefined} />
          </div>

          <h3 className="text-subhead" style={{ margin: "1.1rem 0 0.5rem" }}>AWS · {inventory.aws.region}</h3>
          <table className="data-table">
            <thead><tr><th>Service</th><th>Collector</th><th>Resources</th><th>Current runtime facts</th></tr></thead>
            <tbody>
              <tr><td>EC2</td><td><SourceState status={aws!.ec2.status} errorCode={aws!.ec2.errorCode} /></td><td>{countLabel(aws!.ec2)}</td><td>{aws!.ec2.status === "live" && aws!.ec2.items.length ? aws!.ec2.items.map((i) => `${i.name ?? i.instanceId ?? "instance"} · ${i.instanceType ?? "?"} · ${i.state ?? "?"} · ${i.availabilityZone ?? "?"}`).join("; ") : "—"}</td></tr>
              <tr><td>RDS</td><td><SourceState status={aws!.rds.status} errorCode={aws!.rds.errorCode} /></td><td>{countLabel(aws!.rds)}</td><td>{aws!.rds.status === "live" && aws!.rds.items.length ? aws!.rds.items.map((i) => `${i.identifier ?? "database"} · ${i.engine ?? "?"} ${i.engineVersion ?? ""} · ${i.instanceClass ?? "?"} · ${i.status ?? "?"} · ${i.allocatedStorageGiB ?? "?"} GiB`).join("; ") : "—"}</td></tr>
              <tr><td>S3</td><td><SourceState status={aws!.s3.status} errorCode={aws!.s3.errorCode} /></td><td>{countLabel(aws!.s3)}</td><td>{aws!.s3.status === "live" && aws!.s3.items.length ? aws!.s3.items.map((b) => b.name ?? "bucket").join(", ") : "—"}</td></tr>
              <tr><td>Cognito</td><td><SourceState status={aws!.cognito.status} errorCode={aws!.cognito.errorCode} /></td><td>{countLabel(aws!.cognito)}</td><td>{aws!.cognito.status === "live" && aws!.cognito.items.length ? aws!.cognito.items.map((p) => `${p.name ?? p.id ?? "pool"}${p.status ? ` · ${p.status}` : ""}`).join("; ") : "—"}</td></tr>
              <tr><td>Lambda</td><td><SourceState status={aws!.lambda.status} errorCode={aws!.lambda.errorCode} /></td><td>{countLabel(aws!.lambda)}</td><td>{aws!.lambda.status === "live" && aws!.lambda.items.length ? aws!.lambda.items.map((f) => `${f.functionName ?? "function"} · ${f.runtime ?? "?"} · ${f.memoryMb ?? "?"} MB`).join("; ") : "—"}</td></tr>
              <tr><td>EventBridge Scheduler</td><td><SourceState status={aws!.scheduler.status} errorCode={aws!.scheduler.errorCode} /></td><td>{countLabel(aws!.scheduler)}</td><td>{aws!.scheduler.status === "live" && aws!.scheduler.items.length ? aws!.scheduler.items.map((r) => `${r.name ?? "schedule"} · ${r.state ?? "?"}`).join("; ") : "—"}</td></tr>
            </tbody>
          </table>

          <h3 className="text-subhead" style={{ margin: "1.25rem 0 0.5rem" }}>Azure runtime dependencies</h3>
          <div style={{ display: "grid", gap: "0.85rem" }}>
            <div className="card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.75rem" }}><strong>Azure management plane</strong><SourceState status={azureIdentity?.status ?? "not_configured"} /></div>
              <p style={{ margin: "0.35rem 0", fontSize: "0.88rem" }}>Separate read-only identity for Container Apps inventory and cloud billing evidence.</p>
              <p className="overlay-note" style={{ marginTop: 0 }}>Mode: {statusLabel(azureIdentity?.mode ?? "none")} · subscription configured: {azureIdentity?.subscriptionConfigured ? "yes" : "no"} · resource-group scoped: {azureIdentity?.resourceGroupScoped ? "yes" : "no"} · server-side only: {azureIdentity?.serverSideOnly === false ? "no" : "yes"}. No client credential or access token is returned.</p>
            </div>
            <div className="card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.75rem" }}><strong>Azure Container Apps</strong><SourceState status={apps?.status ?? "not_configured"} errorCode={apps?.errorCode} /></div>
              <p style={{ margin: "0.35rem 0", fontSize: "0.88rem" }}>{apps?.purpose ?? "Server-side Azure management-plane inventory."}</p>
              {apps?.status === "live" && apps.items.length > 0 && <table className="data-table"><thead><tr><th>App</th><th>Location</th><th>State</th><th>Environment</th><th>Ingress</th><th>Managed identity</th></tr></thead><tbody>{apps.items.map((app) => <tr key={`${app.resourceGroup}:${app.name}`}><td>{app.name ?? "container app"}<div className="overlay-note" style={{ marginTop: 0 }}>{app.resourceGroup ?? "resource group unavailable"}</div></td><td>{app.location ?? "—"}</td><td>{app.runningStatus ?? app.provisioningState ?? "—"}</td><td>{app.environmentName ?? "—"}</td><td>{app.ingressHost ?? "—"}{app.ingressExternal ? " · external" : ""}</td><td>{app.managedIdentity ? "present" : "not observed"}</td></tr>)}</tbody></table>}
              {apps?.status !== "live" && <p className="overlay-note">Container Apps are not being represented as an empty list; management-plane coverage is {statusLabel(apps?.status ?? "not_configured")}.</p>}
            </div>
            <div className="card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.75rem" }}><strong>Azure Service Bus</strong><SourceState status={bus!.status} errorCode={bus!.errorCode} /></div>
              <p style={{ margin: "0.35rem 0", fontSize: "0.88rem" }}>{bus!.purpose}</p>
              <p className="overlay-note" style={{ marginTop: 0 }}>Namespace: {bus!.namespaceHost ?? "not configured"}{bus!.queuePrefix ? ` · queue prefix ${bus!.queuePrefix}` : ""}. The connection string is never returned.</p>
              {bus!.status === "live" && bus!.items.length > 0 && <table className="data-table"><thead><tr><th>Queue</th><th>Active</th><th>Scheduled</th><th>Dead letter</th><th>Total</th></tr></thead><tbody>{bus!.items.map((q) => <tr key={q.name}><td>{q.name}</td><td>{q.activeMessages}</td><td>{q.scheduledMessages}</td><td>{q.deadLetterMessages}</td><td>{q.totalMessages}</td></tr>)}</tbody></table>}
            </div>
            <div className="card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.75rem" }}><strong>Stirling-PDF · Azure Container Apps runtime</strong><SourceState status={stirling!.status} errorCode={stirling!.errorCode} /></div>
              <p style={{ margin: "0.35rem 0", fontSize: "0.88rem" }}>{stirling!.purpose}</p>
              <p className="overlay-note" style={{ marginTop: 0 }}>{stirling!.region} · endpoint {stirling!.endpointHost ?? "not configured"} · authentication {stirling!.authMode.replace(/_/g, " ")} · version {stirling!.version ?? "not observed"}. Runtime-endpoint evidence remains separate from Azure management-plane inventory.</p>
            </div>
          </div>
        </>
      )}
    </>
  );
}
