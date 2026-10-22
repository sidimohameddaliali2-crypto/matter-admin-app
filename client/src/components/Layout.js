import React, { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { motion, AnimatePresence } from 'framer-motion';
import {
  LayoutDashboard,
  Users,
  Package,
  ShoppingBag,
  BarChart3,
  CreditCard,
  Menu,
  X,
  LogOut,
  Motorbike,
  Truck,
  ReplaceAll,
  User,
  Calendar,
  AlertTriangle,
  Building2,
  UtensilsCrossed,
  RefreshCw,
  Briefcase,
  FileText,
  Globe,
  LineChart,
  ChevronDown,
  Radar
} from 'lucide-react';
import { logout } from '../store/slices/authSlice';
import UserAvatar from './users/UserAvatar';
import '../styles/matterChrome.css';

const GROUP_ORDER = ['Overview', 'Operations', 'Customers', 'Kitchen & Menus', 'Partners', 'Admin', 'Store Keeper'];

const NAV_ITEMS = [
  { name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard, permission: 'dashboard', group: 'Overview' },

  { name: 'Deliveries', href: '/deliveries', icon: Package, permission: 'deliveries', group: 'Operations' },
  { name: 'Drivers', href: '/drivers', icon: Motorbike, permission: 'drivers', group: 'Operations' },
  { name: 'Fleet', href: '/fleet', icon: Truck, permission: 'fleet', group: 'Operations' },
  { name: 'Live Tracking', href: '/live-tracking', icon: Radar, permission: 'live_map', group: 'Operations' },
  { name: 'Delivery Changes', href: '/delivery-changes', icon: ReplaceAll, permission: 'delivery_changes', group: 'Operations' },
  { name: 'Bag Operations', href: '/bags', icon: ShoppingBag, permission: 'bags', group: 'Operations' },
  { name: 'Report', href: '/reports', icon: BarChart3, permission: 'reports', group: 'Operations' },
  { name: 'Events', href: '/events', icon: Calendar, permission: 'events', group: 'Operations' },
  { name: 'Complaints', href: '/complaints', icon: AlertTriangle, permission: 'complaints', group: 'Operations' },

  { name: 'Customers', href: '/customers', icon: User, permission: 'customers', group: 'Customers' },
  { name: 'Customer Management', href: '/website-subscriptions', icon: Globe, permission: 'website_subscriptions', group: 'Customers' },
  { name: 'Subscription & Sales', href: '/subscription', icon: CreditCard, permission: 'subscription', group: 'Customers' },
  { name: 'Customer Analytics', href: '/customer-analytics', icon: LineChart, permission: 'customer_analytics', group: 'Customers' },
  { name: 'Renewal', href: '/renewal', icon: RefreshCw, permission: 'renewal', group: 'Customers' },

  { name: 'Menus', href: '/menus', icon: Menu, permission: 'menus', group: 'Kitchen & Menus' },
  { name: 'Kitchen List', href: '/kitchen-list', icon: UtensilsCrossed, permission: 'kitchen_list', group: 'Kitchen & Menus' },
  { name: 'Kitchen Counting', href: '/kitchen-counting', icon: BarChart3, permission: 'kitchen_counting', group: 'Kitchen & Menus' },
  { name: 'Matter Core', href: '/matter-core', icon: FileText, permission: 'matter_core', group: 'Kitchen & Menus' },

  { name: 'Partners', href: '/admin/partners', icon: Building2, permission: 'partners', group: 'Partners' },

  { name: 'Users', href: '/users', icon: Users, permission: 'users', group: 'Admin' },
  { name: 'Employees', href: '/employees', icon: Briefcase, permission: 'employees', group: 'Admin' },

];

const Layout = ({ children }) => {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState({});
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useSelector(state => state.auth);

  // Check if a nav item should be visible for the current user.
  // Permission wins: a page keyed with `permission` shows iff that permission is
  // explicitly granted (server sends the effective set). Items with no permission
  // key (e.g. Store Keeper) fall back to their `roles` list.
  const isNavItemVisible = (item) => {
    if (user?.role === 'super_admin') return true;
    if (item.permission) {
      if (user?.role === 'yellowblock_user' && item.permission === 'events') return true;
      return user?.permissions?.[item.permission] === true;
    }
    if (item.roles) return item.roles.includes(user?.role);
    return true;
  };

  const navigationGroups = GROUP_ORDER
    .map((label) => ({
      label,
      items: NAV_ITEMS.filter((item) => item.group === label && isNavItemVisible(item))
    }))
    .filter((group) => group.items.length > 0);

  const toggleGroup = (label) => {
    setCollapsedGroups((prev) => ({ ...prev, [label]: !prev[label] }));
  };

  const handleLogout = () => {
    dispatch(logout());
    navigate('/login');
  };

  const currentPageName = navigationGroups
    .flatMap((group) => group.items)
    .find((item) => item.href === location.pathname)?.name;
  // The Dashboard is the delivery operations view, so its top-bar label is "Operations".
  const headerLabel = currentPageName === 'Dashboard' ? 'Operations' : currentPageName;

  const renderGroups = (onLinkClick) => (
    <nav className="mo-sidebar-scroll flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-1">
      {navigationGroups.map((group) => {
        const isCollapsed = !!collapsedGroups[group.label];
        return (
          <div key={group.label} className="pb-0.5">
            <button
              type="button"
              onClick={() => toggleGroup(group.label)}
              className="w-full flex items-center gap-1.5 px-2 py-2 rounded-lg text-white/60 hover:bg-white/10 transition-colors"
              aria-expanded={!isCollapsed}
            >
              <ChevronDown className={`w-3.5 h-3.5 flex-shrink-0 transition-transform ${isCollapsed ? '-rotate-90' : ''}`} />
              <span className="flex-1 text-left text-[10.5px] font-bold uppercase tracking-wider">{group.label}</span>
              <span className="text-[10.5px] text-white/70 bg-white/10 rounded-full px-1.5">{group.items.length}</span>
            </button>

            {!isCollapsed && (
              <div className="mt-0.5 space-y-0.5">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const isActive = location.pathname === item.href;
                  return (
                    <Link
                      key={item.name}
                      to={item.href}
                      className={`flex items-center pl-6 pr-3 py-2 text-sm font-medium rounded-full transition-colors ${
                        isActive
                          ? 'bg-[#bdf477] text-[#0b1630] font-semibold'
                          : 'text-white/85 hover:bg-white/10'
                      }`}
                      onClick={onLinkClick}
                    >
                      <Icon className="w-4 h-4 mr-2.5 flex-shrink-0" />
                      {item.name}
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );

  return (
    <div className="flex h-screen bg-gray-50 overflow-x-hidden">
      {/* Desktop persistent sidebar */}
      <div
        className={`hidden lg:block h-screen flex-shrink-0 overflow-hidden border-transparent transition-all duration-200 ease-in-out ${
          desktopSidebarOpen ? 'lg:w-64 border-r' : 'lg:w-0 border-r-0'
        }`}
      >
        <div className="mo-chrome-font flex flex-col w-64 h-full bg-[#0b1630]">
          <div className="flex items-center justify-between flex-shrink-0 px-4 py-4">
            <img src="/images/matter-logo24-white.png" alt="MATTER" className="h-6 w-auto" />
            <button
              onClick={() => setDesktopSidebarOpen(false)}
              className="p-1 rounded-md text-white/70 hover:bg-white/10 hover:text-white"
              title="Collapse menu"
            >
              <Menu className="w-6 h-6" />
            </button>
          </div>
          {renderGroups(undefined)}
        </div>
      </div>

      {/* Mobile overlay sidebar */}
      <AnimatePresence>
        {sidebarOpen && (
          <>
            {/* Overlay */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[1000] bg-black bg-opacity-50 lg:hidden"
              onClick={() => setSidebarOpen(false)}
            />

            {/* Sidebar */}
            <motion.div
              initial={{ x: -256 }}
              animate={{ x: 0 }}
              exit={{ x: -256 }}
              transition={{ type: "spring", bounce: 0, duration: 0.3 }}
              className="mo-chrome-font fixed inset-y-0 left-0 z-[1001] w-64 bg-[#0b1630] shadow-xl flex flex-col lg:hidden"
            >
              <div className="flex items-center justify-between flex-shrink-0 px-4 py-4">
                <img src="/images/matter-logo24-white.png" alt="MATTER" className="h-6 w-auto" />
                <button
                  onClick={() => setSidebarOpen(false)}
                  className="p-1 rounded-md text-white"
                >
                  <X className="w-6 h-6" />
                </button>
              </div>

              {renderGroups(() => setSidebarOpen(false))}
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Main content */}
      <div className="flex flex-col flex-1 overflow-hidden">
        {/* Header */}
        <header className="mo-chrome-font mo-app-header relative z-40 flex items-center justify-between flex-wrap gap-x-4 flex-shrink-0 px-6 py-4 bg-[#0b1630] border-b border-white/10 text-white">
          <div className="flex items-center">
            <button
              onClick={() => setSidebarOpen(true)}
              className="p-1 rounded-md lg:hidden text-white"
              title="Open menu"
            >
              <Menu className="w-6 h-6" />
            </button>
            {!desktopSidebarOpen && (
              <button
                onClick={() => setDesktopSidebarOpen(true)}
                className="hidden lg:block p-1 rounded-md text-white/70 hover:bg-white/10 hover:text-white"
                title="Open menu"
              >
                <Menu className="w-6 h-6" />
              </button>
            )}
            {headerLabel && (
              <span className="ml-3 pl-3 border-l border-white/20 text-[11px] tracking-[0.18em] uppercase text-white/80">
                {headerLabel}
              </span>
            )}
          </div>

          {/* Pages can portal their controls here (the Dashboard puts its date navigation in it). */}
          <div id="mo-header-slot" className="mo-header-slot" />

          <div className="flex items-center space-x-4">
            <div className="mo-user-chip flex items-center space-x-3">
              <div className="text-right hidden sm:block">
                <p className="mo-user-name">
                  {user?.profile?.firstName} {user?.profile?.lastName}
                </p>
                <p className="mo-user-role">{user?.role}</p>
              </div>
              <div className="relative">
                <button className="flex items-center text-sm rounded-full focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <UserAvatar
                    user={user}
                    size="medium"
                    showStatus
                    className="shadow-sm"
                    fallbackName="Current User"
                  />
                </button>
              </div>
              <button
                onClick={handleLogout}
                className="p-2 text-white/70 hover:text-white"
                title="Logout"
              >
                <LogOut className="w-5 h-5" />
              </button>
            </div>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto overflow-x-hidden bg-gray-50">
          <div className="h-full">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
};

export default Layout;
