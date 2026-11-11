import React from 'react';
import {Link,useLocation} from 'react-router-dom';
import {useSelector} from 'react-redux';
import RequestReport from '../../components/customerService/RequestReport';

export default function Reporting({filters={},epoch=0}){
 const location=useLocation(),user=useSelector(state=>state.auth.user);
 const query=new URLSearchParams(location.search),conversation=query.get('conversation'),request=query.get('request');
 const back=conversation&&/^[a-f\d]{24}$/.test(conversation)?'/customer-service/chats?'+new URLSearchParams({conversation,...(request&&/^[a-f\d]{24}$/.test(request)?{request}:{})}):'/customer-service/chats';
 const deliveryReports=user?.role==='super_admin'||user?.permissions?.reports===true;
 return <><section className="cs-card"><div className="cs-toolbar"><h2>Customer service reporting</h2><Link to={back}>Back to customer request</Link></div>{deliveryReports&&<Link to="/reports">Open existing delivery reports</Link>}</section><RequestReport filters={filters} epoch={epoch}/></>;
}
