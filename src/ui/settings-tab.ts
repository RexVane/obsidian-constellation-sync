import { PluginSettingTab, Setting, type App } from "obsidian";
import type { DashboardController } from "../controller";
import { translator } from "../i18n";

export class ConstellationSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly controller: DashboardController
  ) {
    super(app, controller as never);
  }

  override display(): void {
    const { containerEl } = this;
    const snapshot = this.controller.snapshot();
    const t = translator(snapshot.settings.locale);
    containerEl.empty();
    containerEl.createEl("h2", { text: "Constellation Sync" });

    new Setting(containerEl)
      .setName(t("overview"))
      .setDesc(t("subtitle"))
      .addButton((button) => button.setButtonText(t("overview")).setCta().onClick(() => void this.controller.activateView()));

    new Setting(containerEl)
      .setName(t("automaticSync"))
      .addToggle((toggle) => toggle.setValue(snapshot.settings.autoSync).onChange((value) => this.controller.updatePreference("autoSync", value)));

    new Setting(containerEl)
      .setName(t("paused"))
      .addToggle((toggle) => toggle.setValue(snapshot.settings.paused).onChange((value) => this.controller.updatePreference("paused", value)));

    new Setting(containerEl)
      .setName(t("deviceName"))
      .addText((text) => text.setValue(snapshot.settings.deviceName).onChange((value) => this.controller.updatePreference("deviceName", value)));

    containerEl.createDiv({ cls: "setting-item-description", text: t("privateNotEncrypted") });
  }
}
