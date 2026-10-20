import { defineRailway, project, service, volume } from "railway/iac";

// Infrastructure for the Cross Engine bot.
//
// The service builds from the Dockerfile in this repository and keeps its
// state on a volume so the price history, positions and fills survive
// restarts and redeploys.
//
// Variables are unmanaged on purpose: the CoinGecko key and the dashboard
// password live in Railway's variable store, never in this repository.
export default defineRailway(() => {
  const cryptoBotVolume = volume("crypto-bot-volume", {
    alerts: { usage: { "80": {}, "95": {}, "100": {} } },
    allowOnlineResize: true,
    region: "iad",
    sizeMB: 500,
  });

  const cryptoBot = service("crypto-bot", {
    build: {
      buildEnvironment: "V3",
      builder: "DOCKERFILE",
      dockerfilePath: "Dockerfile",
    },
    healthcheck: "/health",
    healthcheckTimeout: 120,
    replicas: { "iad": 1 },
    volumeMounts: { "/data": cryptoBotVolume },
  });

  return project("crypto-bot", {
    variables: { managed: false },
    resources: [cryptoBot, cryptoBotVolume],
  });
});
