import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { Provider, useDispatch, useSelector } from 'react-redux';
import { store } from './store/store';
import { Toaster } from './components/ui/toaster';
import { refreshCurrentUser, logout } from './store/slices/authSlice';

// Pages
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Drivers from './pages/Drivers';
import FleetManagement from './pages/FleetManagement';
import LiveTracking from './pages/LiveTracking';
import DriverDetail from './pages/DriverDetail';
import Deliveries from './pages/Deliveries';
import DeliveryDetail from './pages/DeliveryDetail';
import AddDelivery from './pages/AddDelivery';
import BagTracking from './pages/BagOperations';
import Reports from './pages/Reports';
import CreateDriver from './pages/CreateDriver';
import DriverMobile from './pages/DriverMobile';
import Users from './pages/Users'
import Employees from './pages/Employees'
import DeliveryChanges from './pages/DeliveryChanges';
import AddDeliveryChange from './pages/AddDeliveryChange';
import DispatcherMobile from './pages/DispatcherMobile';
import DispatcherDesktop from './pages/DispatcherDesktop';
import DriverRoutesPage from './pages/DriverRoutesPage';
import Customers from './pages/Customers';
import Events from './pages/Events';
import Complaints from './pages/Complaints';
import BatchAutoAssign from './pages/BatchAutoAssign';
import TestAPI from './pages/TestAPI';
import MenuManagement from './pages/MenuManagement';
import KitchenList from './pages/KitchenList';
import KitchenCounting from './pages/KitchenCounting';
import MenuSelectPage from './pages/MenuSelectPage';
import MenuSelectionLinkPage from './pages/MenuSelectionLinkPage';
import MatterCore from './pages/MatterCore';
import MatterCorePdfPage from './pages/MatterCorePdfPage';
import PrivacyPolicy from './pages/PrivacyPolicy';
import YellowblockApp from './pages/YellowblockApp';
import PartnerLogin from './pages/PartnerLogin';
import PartnerPortal from './pages/PartnerPortal';
import MemberJoin from './pages/MemberJoin';
import MemberPortal from './pages/MemberPortal';
import AdminPartners from './pages/AdminPartners';
import Subscription from './pages/Subscription';
import WebsiteSubscription from './pages/WebsiteSubscription';
import CustomerAnalytics from './pages/CustomerAnalytics';
import Renewal from './pages/Renewal';

// Layout
import Layout from './components/Layout';
import { SocketProvider } from './contexts/SocketContext';

// Protected Route Component
const AccessDenied = ({ 
  redirectPath = '/driver-mobile',
  title = 'Access Denied',
  message = 'Drivers can only use the mobile delivery portal. Please return to the driver workspace to continue.',
  ctaLabel = 'Go to Driver Portal'
}) => {
  const navigate = useNavigate();
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100 p-6">
      <div className="bg-white rounded-2xl shadow-xl p-8 text-center space-y-4 max-w-md w-full">
        <div className="w-16 h-16 mx-auto rounded-full bg-red-100 text-red-600 flex items-center justify-center text-3xl font-bold">
          !
        </div>
        <h2 className="text-2xl font-semibold text-gray-900">{title}</h2>
        <p className="text-gray-600">{message}</p>
        <button
          onClick={() => navigate(redirectPath, { replace: true })}
          className="inline-flex items-center justify-center px-5 py-3 bg-blue-600 text-white rounded-xl font-medium shadow hover:bg-blue-500 transition"
        >
          {ctaLabel}
        </button>
      </div>
    </div>
  );
};

// Responsive Dispatcher Component - Shows desktop or mobile based on screen size
const ResponsiveDispatcher = () => {
  const [isDesktop, setIsDesktop] = React.useState(window.innerWidth >= 1024);

  React.useEffect(() => {
    const handleResize = () => {
      setIsDesktop(window.innerWidth >= 1024);
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return isDesktop ? <DispatcherDesktop /> : <DispatcherMobile />;
};

const safeGetUser = () => {
  try {
    return JSON.parse(localStorage.getItem('user') || '{}');
  } catch (error) {
    console.error('Failed to parse user from storage:', error);
    localStorage.removeItem('user');
    return {};
  }
};

const hasPermission = (user, permissionKey) => {
  if (!permissionKey) return true;
  if (user?.role === 'super_admin') return true;
  if (user?.role === 'yellowblock_user' && permissionKey === 'events') return true;
  // A page is visible only when its permission is explicitly granted. The server
  // sends the effective set (role defaults for unconfigured users, the admin's
  // stored choices — including explicit false — once configured).
  return user?.permissions?.[permissionKey] === true;
};

const getFirstAvailablePath = (user) => {
  if (!user?.role) return '/login';

  if (user.role === 'driver') return '/driver-mobile';
  if (user.role === 'dispatcher') return '/dispatcher';
  if (user.role === 'store_keeper') return '/bags';
  if (user.role === 'yellowblock_user') return '/yellowblock';

  // Ordered by likelihood of being granted — first page the user can actually
  // see becomes their landing / fallback route. Permission-driven now, no role list.
  const candidates = [
    { path: '/dashboard', permission: 'dashboard' },
    { path: '/deliveries', permission: 'deliveries' },
    { path: '/reports', permission: 'reports' },
    { path: '/customers', permission: 'customers' },
    { path: '/bags', permission: 'bags' },
    { path: '/events', permission: 'events' },
    { path: '/complaints', permission: 'complaints' },
    { path: '/drivers', permission: 'drivers' },
    { path: '/fleet', permission: 'fleet' },
    { path: '/delivery-changes', permission: 'delivery_changes' },
    { path: '/website-subscriptions', permission: 'website_subscriptions' },
    { path: '/subscription', permission: 'subscription' },
    { path: '/customer-analytics', permission: 'customer_analytics' },
    { path: '/renewal', permission: 'renewal' },
    { path: '/menus', permission: 'menus' },
    { path: '/kitchen-list', permission: 'kitchen_list' },
    { path: '/matter-core', permission: 'matter_core' },
    { path: '/admin/partners', permission: 'partners' },
    { path: '/employees', permission: 'employees' },
    { path: '/users', permission: 'users' },
  ];

  const firstAllowed = candidates.find((item) => hasPermission(user, item.permission));
  return firstAllowed?.path || '/no-access';
};

const AuthBootstrap = () => {
  const dispatch = useDispatch();
  const authToken = useSelector((state) => state.auth.token);

  React.useEffect(() => {
    const token = authToken || localStorage.getItem('token');
    if (token) {
      dispatch(refreshCurrentUser());
    }
  }, [authToken, dispatch]);

  return null;
};

const BagOperationsRoute = ({warehouse=false}) => {
  const user = useSelector(state => state.auth.user) || safeGetUser();
  const dispatch = useDispatch();
  const navigate = useNavigate();
  return warehouse || user?.role === 'store_keeper'
    ? <BagTracking warehouse onLogout={() => {dispatch(logout());navigate('/login');}} />
    : <Layout><BagTracking /></Layout>;
};

const ProtectedRoute = ({ children, allowDrivers = false, allowDispatchers = false, allowStoreKeepers = false, allowYellowblock = false, allowKitchen = false }) => {
  const authUser = useSelector((state) => state.auth.user);
  const token = localStorage.getItem('token');
  if (!token) {
    return <Navigate to="/login" />;
  }
  const user = authUser || safeGetUser();
  
  // Redirect drivers to driver mobile
  if (user.role === 'driver' && !allowDrivers) {
    return <AccessDenied />;
  }
  
  // Redirect dispatchers to dispatcher page
  if (user.role === 'dispatcher' && !allowDispatchers) {
    return <Navigate to="/dispatcher" replace />;
  }
  
  // Redirect store keepers to store-keeper page only
  if (user.role === 'store_keeper' && !allowStoreKeepers) {
    return <Navigate to="/bags" replace />;
  }

  // Redirect yellowblock users to yellowblock page only
  if (user.role === 'yellowblock_user' && !allowYellowblock) {
    return <Navigate to="/yellowblock" replace />;
  }

  // Redirect kitchen users to partner management only
  if (user.role === 'kitchen' && !allowKitchen) {
    return <Navigate to="/admin/partners" replace />;
  }

  return children;
};

// Redirects to the user's first available page, but renders an access-denied
// screen instead of navigating when that page is the one we're already on
// (prevents a redirect loop when the user has no granted pages at all).
const redirectOrDeny = (user, currentPath) => {
  const target = getFirstAvailablePath(user);
  if (target === currentPath || target === '/no-access') {
    return (
      <AccessDenied
        redirectPath="/login"
        title="No access"
        message="Your account doesn't have access to any pages yet. Ask an administrator to grant you page permissions."
        ctaLabel="Back to login"
      />
    );
  }
  return <Navigate to={target} replace />;
};

const RoleBasedRoute = ({ children, allowedRoles }) => {
  const authUser = useSelector((state) => state.auth.user);
  const location = useLocation();
  const user = authUser || safeGetUser();
  return allowedRoles.includes(user.role) ? children : redirectOrDeny(user, location.pathname);
};

// Blocks access unless the user's permission for a given key is explicitly granted
// (super_admin always passes).
const PermissionBasedRoute = ({ children, permission }) => {
  const authUser = useSelector((state) => state.auth.user);
  const location = useLocation();
  const user = authUser || safeGetUser();
  if (!hasPermission(user, permission)) {
    return redirectOrDeny(user, location.pathname);
  }
  return children;
};

// Separate guard for partner portal — uses partnerToken, not internal user token
const PartnerRoute = ({ children }) => {
  const partnerToken = localStorage.getItem('partnerToken');
  if (!partnerToken) return <Navigate to="/partner/login" replace />;
  return children;
};

// Guard for the member portal — uses memberToken; no member login page, so
// fall back to the last-used join link (or home).
const MemberRoute = ({ children }) => {
  const memberToken = localStorage.getItem('memberToken');
  if (!memberToken) return <Navigate to={localStorage.getItem('memberInvitePath') || '/'} replace />;
  return children;
};

function App() {
  return (
    <Provider store={store}>
      <SocketProvider>
      <Router>
        <AuthBootstrap />
        <div className="App">
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/privacy-policy" element={<PrivacyPolicy />} />
            <Route path="/partner/login" element={<PartnerLogin />} />
            <Route path="/partner/portal" element={<PartnerRoute><PartnerPortal /></PartnerRoute>} />
            <Route path="/join/:token" element={<MemberJoin />} />
            <Route path="/member/portal" element={<MemberRoute><MemberPortal /></MemberRoute>} />
            
            <Route path="/" element={
              <ProtectedRoute>
                <Navigate to="/dashboard" replace />
              </ProtectedRoute>
            } />
            
            <Route path="/dashboard" element={
              <ProtectedRoute>
                <PermissionBasedRoute permission="dashboard">
                  <Layout>
                    <Dashboard />
                  </Layout>
                </PermissionBasedRoute>
              </ProtectedRoute>
            } />

            <Route path="/drivers" element={
              <ProtectedRoute>
                <PermissionBasedRoute permission="drivers">
                  <Layout>
                    <Drivers />
                  </Layout>
                </PermissionBasedRoute>
              </ProtectedRoute>
            } />

            <Route path="/fleet" element={
              <ProtectedRoute>
                <PermissionBasedRoute permission="fleet">
                  <Layout>
                    <FleetManagement />
                  </Layout>
                </PermissionBasedRoute>
              </ProtectedRoute>
            } />

            <Route path="/live-tracking" element={
              <ProtectedRoute>
                <PermissionBasedRoute permission="live_map">
                  <Layout>
                    <LiveTracking />
                  </Layout>
                </PermissionBasedRoute>
              </ProtectedRoute>
            } />

            <Route path="/drivers/create" element={
              <ProtectedRoute>
                <PermissionBasedRoute permission="drivers">
                  <Layout>
                    <CreateDriver />
                  </Layout>
                </PermissionBasedRoute>
              </ProtectedRoute>
            } />
            
            <Route path="/drivers/:id" element={
              <ProtectedRoute>
                <PermissionBasedRoute permission="drivers">
                  <Layout>
                    <DriverDetail />
                  </Layout>
                </PermissionBasedRoute>
              </ProtectedRoute>
            } />
            <Route path="/driver-mobile" element={
              <ProtectedRoute allowDrivers>
                <DriverMobile />
              </ProtectedRoute>
} />
            <Route path="/dispatcher" element={
              <ProtectedRoute allowDispatchers>
                <RoleBasedRoute allowedRoles={['super_admin', 'admin', 'manager', 'dispatcher']}>
                  <ResponsiveDispatcher />
                </RoleBasedRoute>
              </ProtectedRoute>
            } />
            <Route path="/dispatcher/driver-routes" element={
              <ProtectedRoute allowDispatchers>
                <RoleBasedRoute allowedRoles={['super_admin', 'admin', 'manager', 'dispatcher']}>
                  <DriverRoutesPage />
                </RoleBasedRoute>
              </ProtectedRoute>
            } />

            <Route path="/store-keeper" element={
              <ProtectedRoute allowStoreKeepers>
                <RoleBasedRoute allowedRoles={['super_admin', 'admin', 'store_keeper']}>
                  <PermissionBasedRoute permission="bags">
                    <BagOperationsRoute warehouse />
                  </PermissionBasedRoute>
                </RoleBasedRoute>
              </ProtectedRoute>
            } />
            
            <Route path="/users" element={
  <ProtectedRoute>
    <PermissionBasedRoute permission="users">
      <Layout>
        <Users />
      </Layout>
    </PermissionBasedRoute>
  </ProtectedRoute>
} />
            <Route path="/employees" element={
  <ProtectedRoute>
    <PermissionBasedRoute permission="employees">
      <Layout>
        <Employees />
      </Layout>
    </PermissionBasedRoute>
  </ProtectedRoute>
} />
            <Route path="/deliveries" element={
              <ProtectedRoute>
                <PermissionBasedRoute permission="deliveries">
                  <Layout>
                    <Deliveries />
                  </Layout>
                </PermissionBasedRoute>
              </ProtectedRoute>
            } />

            <Route path="/customers" element={
              <ProtectedRoute>
                <PermissionBasedRoute permission="customers">
                  <Layout>
                    <Customers />
                  </Layout>
                </PermissionBasedRoute>
              </ProtectedRoute>
            } />

            <Route path="/events" element={
              <ProtectedRoute allowDispatchers allowYellowblock>
                <PermissionBasedRoute permission="events">
                  <Layout>
                    <Events />
                  </Layout>
                </PermissionBasedRoute>
              </ProtectedRoute>
            } />

            <Route path="/dispatcher/events" element={
              <ProtectedRoute allowDispatchers>
                <RoleBasedRoute allowedRoles={['super_admin', 'admin', 'dispatcher']}>
                  <Events showBackButton />
                </RoleBasedRoute>
              </ProtectedRoute>
            } />

            <Route path="/complaints" element={
              <ProtectedRoute>
                <PermissionBasedRoute permission="complaints">
                  <Layout>
                    <Complaints />
                  </Layout>
                </PermissionBasedRoute>
              </ProtectedRoute>
            } />

            <Route path="/batch-auto-assign" element={
              <ProtectedRoute>
                <RoleBasedRoute allowedRoles={['super_admin', 'admin', 'dispatcher']}>
                  <Layout>
                    <BatchAutoAssign />
                  </Layout>
                </RoleBasedRoute>
              </ProtectedRoute>
            } />

            <Route path="/test-api" element={
              <ProtectedRoute>
                <TestAPI />
              </ProtectedRoute>
            } />
            
            <Route path="/deliveries/:id" element={
              <ProtectedRoute>
                <Layout>
                  <DeliveryDetail />
                </Layout>
              </ProtectedRoute>
            } />
            
            <Route path="/add-delivery" element={
              <ProtectedRoute>
                <Layout>
                  <AddDelivery />
                </Layout>
              </ProtectedRoute>
            } />
            
            <Route path="/bags" element={
              <ProtectedRoute allowStoreKeepers>
                <PermissionBasedRoute permission="bags">
                  <BagOperationsRoute />
                </PermissionBasedRoute>
              </ProtectedRoute>
            } />
            
            <Route path="/reports" element={
              <ProtectedRoute>
                <PermissionBasedRoute permission="reports">
                  <Layout>
                    <Reports />
                  </Layout>
                </PermissionBasedRoute>
              </ProtectedRoute>
            } />
            <Route path="/subscription" element={
              <ProtectedRoute>
                <PermissionBasedRoute permission="subscription">
                  <Layout>
                    <Subscription />
                  </Layout>
                </PermissionBasedRoute>
              </ProtectedRoute>
            } />
            <Route path="/website-subscriptions" element={
              <ProtectedRoute>
                <PermissionBasedRoute permission="website_subscriptions">
                  <Layout>
                    <WebsiteSubscription />
                  </Layout>
                </PermissionBasedRoute>
              </ProtectedRoute>
            } />
            <Route path="/website-subscriptions/:id" element={
              <ProtectedRoute>
                <PermissionBasedRoute permission="website_subscriptions">
                  <Layout>
                    <WebsiteSubscription />
                  </Layout>
                </PermissionBasedRoute>
              </ProtectedRoute>
            } />
            <Route path="/customer-analytics" element={
              <ProtectedRoute>
                <PermissionBasedRoute permission="customer_analytics">
                  <Layout>
                    <CustomerAnalytics />
                  </Layout>
                </PermissionBasedRoute>
              </ProtectedRoute>
            } />
            <Route path="/renewal" element={
              <ProtectedRoute>
                <PermissionBasedRoute permission="renewal">
                  <Layout>
                    <Renewal />
                  </Layout>
                </PermissionBasedRoute>
              </ProtectedRoute>
            } />
             <Route path="/delivery-changes" element={
              <ProtectedRoute>
                <PermissionBasedRoute permission="delivery_changes">
                  <Layout>
                    <DeliveryChanges />
                  </Layout>
                </PermissionBasedRoute>
              </ProtectedRoute>
            } />

            <Route path="/delivery-changes/add" element={
              <ProtectedRoute>
                <PermissionBasedRoute permission="delivery_changes">
                  <Layout>
                    <AddDeliveryChange />
                  </Layout>
                </PermissionBasedRoute>
              </ProtectedRoute>
            } />

            <Route path="/menus" element={
              <ProtectedRoute>
                <PermissionBasedRoute permission="menus">
                  <Layout>
                    <MenuManagement />
                  </Layout>
                </PermissionBasedRoute>
              </ProtectedRoute>
            } />

            <Route path="/menu-select/:token" element={
              <MenuSelectPage />
            } />

            {/* Standalone design preview (demo data only). The real redesigned
                flow is served from /menu-select/:token itself, for every menu. */}
            <Route path="/menu-select-v2" element={
              <MenuSelectionLinkPage />
            } />

            <Route path="/matter-core" element={
              <ProtectedRoute>
                <PermissionBasedRoute permission="matter_core">
                  <Layout>
                    <MatterCore />
                  </Layout>
                </PermissionBasedRoute>
              </ProtectedRoute>
            } />

            <Route path="/matter-core/:token" element={
              <MatterCorePdfPage />
            } />

            <Route path="/admin/partners" element={
              <ProtectedRoute allowKitchen>
                <PermissionBasedRoute permission="partners">
                  <Layout>
                    <AdminPartners />
                  </Layout>
                </PermissionBasedRoute>
              </ProtectedRoute>
            } />

            <Route path="/kitchen-list" element={
              <ProtectedRoute allowKitchen>
                <PermissionBasedRoute permission="kitchen_list">
                  <Layout>
                    <KitchenList />
                  </Layout>
                </PermissionBasedRoute>
              </ProtectedRoute>
            } />

            <Route path="/kitchen-counting" element={
              <ProtectedRoute allowKitchen>
                <PermissionBasedRoute permission="kitchen_counting">
                  <Layout>
                    <KitchenCounting />
                  </Layout>
                </PermissionBasedRoute>
              </ProtectedRoute>
            } />

            <Route path="/yellowblock/*" element={
              <ProtectedRoute allowYellowblock>
                <RoleBasedRoute allowedRoles={['super_admin', 'admin', 'yellowblock_user']}>
                  <YellowblockApp />
                </RoleBasedRoute>
              </ProtectedRoute>
            } />
          </Routes>
          <Toaster />
        </div>
      </Router>
      </SocketProvider>
    </Provider>
  );
}

export default App;
