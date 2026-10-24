include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-usbpower-temperature
PKG_VERSION:=1.3.2
PKG_RELEASE:=1
PKG_LICENSE:=MIT
PKG_MAINTAINER:=luci-app-usbpower-temperature contributors

LUCI_TITLE:=USB port thermal control for LuCI
LUCI_DEPENDS:=+luci-base
LUCI_PKGARCH:=all

include $(TOPDIR)/feeds/luci/luci.mk

define Package/$(PKG_NAME)/conffiles
/etc/config/usbpower_temperature
endef

define Package/$(PKG_NAME)/install
	$(INSTALL_DIR) $(1)/
	$(CP) ./root/* $(1)/
endef

define Package/$(PKG_NAME)/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] && exit 0
/etc/init.d/rpcd reload >/dev/null 2>&1
/etc/init.d/usbpower_temperature enable
[ "$$(uci -q get usbpower_temperature.settings.enabled)" = "1" ] && /etc/init.d/usbpower_temperature restart
rm -f /tmp/luci-indexcache* 2>/dev/null
exit 0
endef

define Package/$(PKG_NAME)/prerm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] && exit 0
/etc/init.d/usbpower_temperature stop >/dev/null 2>&1 || true
/etc/init.d/usbpower_temperature disable
exit 0
endef

define Package/$(PKG_NAME)/postrm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] && exit 0
/etc/init.d/rpcd reload >/dev/null 2>&1
rm -f /tmp/luci-indexcache* 2>/dev/null
exit 0
endef

$(eval $(call BuildPackage,$(PKG_NAME)))
