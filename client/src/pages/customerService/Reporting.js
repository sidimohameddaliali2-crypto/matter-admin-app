import React from 'react';
import {Link,useLocation} from 'react-router-dom';
import {useSelector} from 'react-redux';
import RequestReport from '../../components/customerService/RequestReport';
import {updateServiceFilterSearch} from '../../components/customerService/serviceUtils';

export default function Reporting({filters={},epoch=0,inboxHref='/customer-service/chats'}){
 const location=useLocation(),user=useSelector(state=>state.auth.user);
 const query=new URLSearchParams(location.search),conversation=query.get('conversation'),request=query.get('request');
 const hasConversation=conversation&&/^[a-f\d]{24}$/.test(conversation);
 const hasRequest=request&&/^[a-f\d]{24}$/.test(request);
 const returnSearch=new URLSearchParams(updateServiceFilterSearch(filters,location.search));
 if(!hasRequest)returnSearch.delete('request');
 const back=hasConversation?'/customer-service/chats?'+returnSearch:inboxHref;
 const deliveryReports=user?.role==='super_admin'||user?.permissions?.reports===true;
 return <><section className="cs-card"><div className="cs-toolbar"><h2>Customer service reporting</h2><Link to={back}>{hasConversation?(hasRequest?'Back to customer request':'Back to conversation'):'Back to inbox'}</Link></div>{deliveryReports&&<Link to="/reports">Open existing delivery reports</Link>}</section><RequestReport filters={filters} epoch={epoch}/></>;
}
